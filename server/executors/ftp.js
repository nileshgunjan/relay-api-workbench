'use strict';

const { Writable } = require('node:stream');
const { performance } = require('node:perf_hooks');
const ftp = require('basic-ftp');
const SftpClient = require('ssh2-sftp-client');

const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);
const MAX_BODY_MB = parseInt(process.env.MAX_BODY_MB || '50', 10);
const MAX_BYTES = MAX_BODY_MB * 1024 * 1024;

/**
 * A Writable that buffers into memory with a hard cap.
 */
function collectStream(limit) {
  const chunks = [];
  let total = 0;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length;
      if (total > limit) {
        cb(new Error(`File exceeds the ${MAX_BODY_MB} MB limit.`));
        return;
      }
      chunks.push(chunk);
      cb();
    },
  });
  stream.getBuffer = () => Buffer.concat(chunks);
  return stream;
}

/**
 * Execute an FTP / SFTP operation server-side.
 * spec: {
 *   protocol: 'ftp' | 'ftps' | 'sftp',
 *   host, port, username, password,
 *   operation: 'list' | 'download' | 'upload',
 *   path,                // remote directory (list) or file (download/upload)
 *   uploadContent,       // base64 or utf8 string for upload
 *   uploadEncoding,      // 'base64' | 'utf8'
 * }
 */
async function executeFtp(spec) {
  const protocol = (spec.protocol || 'ftp').toLowerCase();
  const operation = (spec.operation || 'list').toLowerCase();

  // Normalize — a stray space / newline / zero-width char in a pasted host makes
  // DNS resolution fail even though a GUI client (which trims) connects fine.
  const rawHost = spec.host == null ? '' : String(spec.host);
  // Strip all whitespace + zero-width chars (U+200B–U+200D) + BOM (U+FEFF).
  spec.host = rawHost.replace(/[\s​-‍﻿]+/g, '');
  if (spec.username != null) spec.username = String(spec.username).trim();
  if (spec.port != null) spec.port = String(spec.port).trim();
  if (!spec.host) return { ok: false, error: 'Host is required.' };

  const start = performance.now();
  try {
    let result;
    if (protocol === 'sftp') {
      result = await runSftp(spec, operation);
    } else {
      result = await runFtp(spec, operation, protocol === 'ftps');
    }
    return { ok: true, timeMs: Math.round(performance.now() - start), ...result };
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    if (/lookup|enotfound|getaddrinfo|address lookup/i.test(msg)) {
      const cleaned = spec.host === rawHost.trim();
      msg = `DNS lookup failed for host "${spec.host}" (${spec.host.length} chars). ` +
            `Verify the hostname resolves from THIS server` +
            (cleaned ? '.' : ` — note the pasted value contained extra characters that were stripped.`);
    }
    return {
      ok: false,
      timeMs: Math.round(performance.now() - start),
      error: msg,
    };
  }
}

async function runFtp(spec, operation, secure) {
  const client = new ftp.Client(TIMEOUT_MS);
  client.ftp.verbose = false;
  try {
    // Default to control port 21 for both plain FTP and explicit FTPS (AUTH TLS).
    // If the user explicitly picks port 990, treat it as implicit FTPS.
    const port = spec.port ? parseInt(spec.port, 10) : 21;
    let secureMode = secure;
    if (secure && port === 990) secureMode = 'implicit';

    await client.access({
      host: spec.host,
      port,
      user: spec.username || 'anonymous',
      password: spec.password || 'anonymous@',
      secure: secureMode,
      secureOptions: { rejectUnauthorized: false },
    });

    if (operation === 'list') {
      const dir = spec.path || '/';
      const list = await client.list(dir);
      return {
        operation: 'list',
        path: dir,
        entries: list.map((e) => ({
          name: e.name,
          type: e.isDirectory ? 'dir' : e.isSymbolicLink ? 'link' : 'file',
          size: e.size,
          modifiedAt: e.modifiedAt ? e.modifiedAt.toISOString() : null,
          permissions: e.rawModifiedAt || null,
        })),
      };
    }

    if (operation === 'download') {
      if (!spec.path) throw new Error('Remote file path is required for download.');
      const sink = collectStream(MAX_BYTES);
      await client.downloadTo(sink, spec.path);
      const buf = sink.getBuffer();
      return fileResult(spec.path, buf);
    }

    if (operation === 'upload') {
      if (!spec.path) throw new Error('Remote file path is required for upload.');
      const buf = decodeUpload(spec);
      const { Readable } = require('node:stream');
      await client.uploadFrom(Readable.from(buf), spec.path);
      return { operation: 'upload', path: spec.path, sizeBytes: buf.length, message: 'Upload complete.' };
    }

    throw new Error(`Unsupported FTP operation: ${operation}`);
  } finally {
    client.close();
  }
}

async function runSftp(spec, operation) {
  const client = new SftpClient();
  try {
    await client.connect({
      host: spec.host,
      port: spec.port ? parseInt(spec.port, 10) : 22,
      username: spec.username,
      password: spec.password,
      readyTimeout: TIMEOUT_MS,
    });

    if (operation === 'list') {
      const dir = spec.path || '.';
      const list = await client.list(dir);
      return {
        operation: 'list',
        path: dir,
        entries: list.map((e) => ({
          name: e.name,
          type: e.type === 'd' ? 'dir' : e.type === 'l' ? 'link' : 'file',
          size: e.size,
          modifiedAt: e.modifyTime ? new Date(e.modifyTime).toISOString() : null,
          permissions: e.rights ? `${e.rights.user}${e.rights.group}${e.rights.other}` : null,
        })),
      };
    }

    if (operation === 'download') {
      if (!spec.path) throw new Error('Remote file path is required for download.');
      const buf = await client.get(spec.path); // returns a Buffer
      if (buf.length > MAX_BYTES) throw new Error(`File exceeds the ${MAX_BODY_MB} MB limit.`);
      return fileResult(spec.path, buf);
    }

    if (operation === 'upload') {
      if (!spec.path) throw new Error('Remote file path is required for upload.');
      const buf = decodeUpload(spec);
      await client.put(buf, spec.path);
      return { operation: 'upload', path: spec.path, sizeBytes: buf.length, message: 'Upload complete.' };
    }

    throw new Error(`Unsupported SFTP operation: ${operation}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

function decodeUpload(spec) {
  const enc = spec.uploadEncoding === 'base64' ? 'base64' : 'utf8';
  const buf = Buffer.from(spec.uploadContent || '', enc);
  if (buf.length > MAX_BYTES) throw new Error(`Upload exceeds the ${MAX_BODY_MB} MB limit.`);
  return buf;
}

function fileResult(path, buf) {
  const isText = looksTextual(buf);
  return {
    operation: 'download',
    path,
    sizeBytes: buf.length,
    body: isText ? buf.toString('utf8') : buf.toString('base64'),
    bodyEncoding: isText ? 'utf8' : 'base64',
  };
}

function looksTextual(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const byte of sample) {
    // NUL byte or most control chars (except tab/newline/carriage return) => binary
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) return false;
  }
  return true;
}

module.exports = { executeFtp };
