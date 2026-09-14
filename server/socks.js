'use strict';

/**
 * Authenticated SOCKS5 proxy (RFC 1928 + username/password auth RFC 1929).
 *
 * Purpose: let a developer run an integration process (e.g. WooCommerceGetOrders
 * from IntelliJ) on their laptop while its network traffic EGRESSES from this
 * whitelisted AWS host. Point the JVM at this proxy:
 *
 *   -DsocksProxyHost=<this-host> -DsocksProxyPort=1080
 *   -Djava.net.socks.username=<user> -Djava.net.socks.password=<pass>
 *
 * Java routes ALL TCP through SOCKS, so REST/HTTPS, SFTP, and passive FTP/FTPS
 * all exit from this box. Hostnames are resolved here (remote DNS), so vendor
 * DNS resolves from AWS too.
 *
 * Only the CONNECT command is supported (no BIND/UDP-ASSOCIATE). Auth is required
 * — the no-auth method is never offered — and an optional IP allowlist can be set.
 *
 * SECURITY: this is an outbound proxy. Anyone who can reach this port and knows
 * the credentials can send traffic from this host's IP. Restrict the port with a
 * security group / firewall to known developer IPs, use strong credentials, and
 * prefer running it behind a VPN where possible.
 */

const net = require('node:net');

const ENABLED = String(process.env.SOCKS_ENABLED || 'false').toLowerCase() === 'true';
const PORT = parseInt(process.env.SOCKS_PORT || '1080', 10);
const BIND = process.env.SOCKS_BIND || '0.0.0.0';
const USER = process.env.SOCKS_USERNAME || process.env.AUTH_USERNAME || 'admin';
const PASS = process.env.SOCKS_PASSWORD || process.env.AUTH_PASSWORD || '';
const ALLOW_IPS = (process.env.SOCKS_ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONNECT_TIMEOUT = parseInt(process.env.SOCKS_CONNECT_TIMEOUT_MS || '20000', 10);

// SOCKS5 constants
const VER = 0x05;
const METHOD_USERPASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_OK = 0x00;
const REP_GENERAL_FAIL = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONN_REFUSED = 0x05;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipI = ipv4ToInt(ip), rI = ipv4ToInt(range);
  if (ipI == null || rI == null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipI & mask) === (rI & mask);
}
/**
 * Allowlist supports exact IPs and CIDR ranges (e.g. a VPN subnet "10.8.0.0/16").
 * Empty list = allow any source that can reach the port (rely on the security
 * group / VPN boundary + SOCKS credentials).
 */
function ipAllowed(remote) {
  if (!ALLOW_IPS.length) return true;
  const ip = (remote || '').replace(/^::ffff:/, '');
  return ALLOW_IPS.some((entry) => (entry.includes('/') ? inCidr(ip, entry) : entry === ip));
}

function start() {
  if (!ENABLED) return null;
  if (!PASS) {
    console.warn('[socks] SOCKS_ENABLED but no password set (SOCKS_PASSWORD / AUTH_PASSWORD). Refusing to start an unauthenticated proxy.');
    return null;
  }
  const server = net.createServer((socket) => handleClient(socket));
  server.on('error', (e) => console.error('[socks] server error:', e.message));
  server.listen(PORT, BIND, () => {
    console.log(`SOCKS5 proxy listening on ${BIND}:${PORT} (username/password auth required)` + (ALLOW_IPS.length ? ` · IP allowlist: ${ALLOW_IPS.join(', ')}` : ''));
  });
  return server;
}

function handleClient(socket) {
  socket.setNoDelay(true);
  if (!ipAllowed(socket.remoteAddress)) { socket.destroy(); return; }

  let stage = 'greeting';
  let buf = Buffer.alloc(0);
  socket.on('error', () => socket.destroy());

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Drive the handshake stages. Each parser consumes from `buf` or waits for more.
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        if (stage === 'greeting') { progressed = parseGreeting(); }
        else if (stage === 'auth') { progressed = parseAuth(); }
        else if (stage === 'request') { progressed = parseRequest(); }
      }
    } catch (e) {
      socket.destroy();
    }
  });

  function parseGreeting() {
    if (buf.length < 2) return false;
    if (buf[0] !== VER) { socket.destroy(); return false; }
    const n = buf[1];
    if (buf.length < 2 + n) return false;
    const methods = buf.subarray(2, 2 + n);
    buf = buf.subarray(2 + n);
    if (!methods.includes(METHOD_USERPASS)) {
      socket.end(Buffer.from([VER, METHOD_NONE_ACCEPTABLE]));
      return false;
    }
    socket.write(Buffer.from([VER, METHOD_USERPASS]));
    stage = 'auth';
    return true;
  }

  function parseAuth() {
    if (buf.length < 2) return false;
    // VER(1)=0x01, ULEN(1), UNAME, PLEN(1), PASSWD
    if (buf[0] !== 0x01) { socket.destroy(); return false; }
    const ulen = buf[1];
    if (buf.length < 2 + ulen + 1) return false;
    const uname = buf.subarray(2, 2 + ulen).toString('utf8');
    const plen = buf[2 + ulen];
    if (buf.length < 2 + ulen + 1 + plen) return false;
    const passwd = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
    buf = buf.subarray(3 + ulen + plen);

    if (uname === USER && passwd === PASS) {
      socket.write(Buffer.from([0x01, 0x00])); // success
      stage = 'request';
      return true;
    }
    socket.end(Buffer.from([0x01, 0x01])); // failure
    return false;
  }

  function parseRequest() {
    if (buf.length < 4) return false;
    if (buf[0] !== VER) { socket.destroy(); return false; }
    const cmd = buf[1];
    const atyp = buf[3];
    let host, offset;
    if (atyp === ATYP_IPV4) {
      if (buf.length < 10) return false;
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      offset = 8;
    } else if (atyp === ATYP_DOMAIN) {
      const dlen = buf[4];
      if (buf.length < 5 + dlen + 2) return false;
      host = buf.subarray(5, 5 + dlen).toString('utf8');
      offset = 5 + dlen;
    } else if (atyp === ATYP_IPV6) {
      if (buf.length < 22) return false;
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
      host = parts.join(':');
      offset = 20;
    } else {
      reply(REP_ATYP_NOT_SUPPORTED); socket.destroy(); return false;
    }
    const port = buf.readUInt16BE(offset);
    buf = buf.subarray(offset + 2);

    if (cmd !== CMD_CONNECT) { reply(REP_CMD_NOT_SUPPORTED); socket.destroy(); return false; }

    stage = 'relay';
    connectTarget(host, port);
    return false;
  }

  function connectTarget(host, port) {
    const target = net.createConnection({ host, port });
    target.setNoDelay(true);
    let settled = false;
    const to = setTimeout(() => { if (!settled) { settled = true; reply(REP_HOST_UNREACHABLE); target.destroy(); socket.destroy(); } }, CONNECT_TIMEOUT);

    target.on('connect', () => {
      settled = true; clearTimeout(to);
      reply(REP_OK);
      // Flush any bytes the client already sent after the request.
      if (buf.length) { target.write(buf); buf = Buffer.alloc(0); }
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', (e) => {
      if (settled) { socket.destroy(); return; }
      settled = true; clearTimeout(to);
      const code = e.code === 'ECONNREFUSED' ? REP_CONN_REFUSED : e.code === 'ENOTFOUND' ? REP_HOST_UNREACHABLE : REP_GENERAL_FAIL;
      reply(code); socket.destroy();
    });
    target.on('close', () => socket.destroy());
    socket.on('close', () => target.destroy());
  }

  function reply(rep) {
    // VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
    try { socket.write(Buffer.from([VER, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])); } catch {}
  }
}

module.exports = { start, isEnabled: () => ENABLED };
