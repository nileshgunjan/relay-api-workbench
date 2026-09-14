'use strict';

/**
 * Convert a Postman Collection (schema v2.0 / v2.1) into Relay's collection shape:
 *   { name, requests: [ { name, proto, method, url, params[], headers[], auth{},
 *                         bodyMode, body, contentType, soapAction, formData[] } ] }
 *
 * Folders are flattened (Relay is one level deep) with their names prefixed onto
 * each request ("Folder / Sub / Request"). Collection-level variables are
 * substituted into request strings so the imported requests are runnable.
 */

function str(v) { return v == null ? '' : String(v); }

function isPostman(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const schema = doc.info && doc.info.schema;
  if (typeof schema === 'string' && /getpostman\.com|schema\.postman|collection\.json/i.test(schema)) return true;
  // v2 files sometimes omit the schema string; fall back to structure.
  return !!(doc.info && Array.isArray(doc.item));
}

/* ---------- URL ---------- */
function mapUrl(url) {
  let raw = '';
  if (typeof url === 'string') raw = url;
  else if (url && typeof url === 'object') raw = str(url.raw);

  let base = raw.split('#')[0];
  const qIdx = base.indexOf('?');
  if (qIdx >= 0) base = base.slice(0, qIdx);

  let params = [];
  if (url && Array.isArray(url.query)) {
    params = url.query.map((q) => ({ key: str(q.key), value: str(q.value), enabled: !q.disabled }));
  } else if (qIdx >= 0) {
    const qs = raw.slice(raw.indexOf('?') + 1).split('#')[0];
    params = qs.split('&').filter(Boolean).map((kv) => {
      const eq = kv.indexOf('=');
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      const v = eq >= 0 ? kv.slice(eq + 1) : '';
      return { key: safeDecode(k), value: safeDecode(v), enabled: true };
    });
  }

  // Substitute path variables (:id) if the collection provided values.
  if (url && Array.isArray(url.variable)) {
    for (const v of url.variable) {
      if (v && v.key) base = base.split(':' + v.key).join(str(v.value));
    }
  }
  return { url: base, params };
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/* ---------- Headers ---------- */
function mapHeaders(h) {
  return Array.isArray(h)
    ? h.filter((x) => x && x.key != null).map((x) => ({ key: str(x.key), value: str(x.value), enabled: !x.disabled }))
    : [];
}

/* ---------- Auth ---------- */
function mapAuth(block) {
  if (!block || !block.type) return null;
  const t = block.type;
  const inner = block[t];
  const kv = {};
  if (Array.isArray(inner)) inner.forEach((e) => { if (e && e.key != null) kv[e.key] = e.value; });
  else if (inner && typeof inner === 'object') Object.assign(kv, inner);

  if (t === 'bearer') return { type: 'bearer', token: str(kv.token) };
  if (t === 'basic') return { type: 'basic', username: str(kv.username), password: str(kv.password) };
  if (t === 'apikey') return { type: 'apikey', key: str(kv.key), value: str(kv.value), in: kv.in === 'query' ? 'query' : 'header' };
  if (t === 'noauth') return { type: 'none' };
  // oauth1/2, digest, ntlm, awsv4, etc. are not supported — leave as none and keep any auth headers.
  return null;
}

/* ---------- Body ---------- */
function mapBody(request) {
  const b = request.body;
  const headers = Array.isArray(request.header) ? request.header : [];
  const soapActionHeader = headers.find((h) => str(h.key).toLowerCase() === 'soapaction');

  if (!b || !b.mode || b.mode === 'none') return { bodyMode: 'none' };

  if (b.mode === 'raw') {
    const raw = str(b.raw);
    const lang = (b.options && b.options.raw && b.options.raw.language) || '';
    const looksXml = /^\s*<\?xml/i.test(raw) || /<\w+[\s>/]/.test(raw);
    const isSoap = !!soapActionHeader || /soap[:\-]envelope/i.test(raw) || /schemas\.xmlsoap\.org\/soap|www\.w3\.org\/2003\/05\/soap/i.test(raw);
    if (isSoap) {
      return { proto: 'soap', bodyMode: 'soap', body: raw, soapAction: str(soapActionHeader && soapActionHeader.value) };
    }
    if (lang === 'json' || (!lang && /^\s*[[{]/.test(raw))) return { bodyMode: 'json', body: raw };
    if (lang === 'xml' || looksXml) return { bodyMode: 'raw', body: raw, contentType: 'application/xml' };
    const ct = lang === 'html' ? 'text/html' : lang === 'javascript' ? 'application/javascript' : 'text/plain';
    return { bodyMode: 'raw', body: raw, contentType: ct };
  }

  if (b.mode === 'urlencoded') {
    return { bodyMode: 'form', formData: (b.urlencoded || []).map((x) => ({ key: str(x.key), value: str(x.value), enabled: !x.disabled })) };
  }

  if (b.mode === 'formdata') {
    // Relay has no multipart; keep text fields as urlencoded, drop file fields.
    const fields = (b.formdata || []).filter((x) => x.type !== 'file').map((x) => ({ key: str(x.key), value: str(x.value), enabled: !x.disabled }));
    if (!fields.length) return { bodyMode: 'none' };
    return { bodyMode: 'form', formData: fields };
  }

  if (b.mode === 'graphql') {
    const g = b.graphql || {};
    let variables = g.variables;
    try { variables = JSON.parse(g.variables); } catch { /* leave as string */ }
    return { bodyMode: 'json', body: JSON.stringify({ query: g.query || '', variables: variables || {} }, null, 2) };
  }

  // file / other
  return { bodyMode: 'none' };
}

/* ---------- Variable substitution ---------- */
function subst(s, vars) {
  if (typeof s !== 'string' || !vars) return s;
  return s.replace(/\{\{([^}]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

function applyVars(req, vars) {
  if (!vars || !Object.keys(vars).length) return req;
  req.url = subst(req.url, vars);
  req.body = subst(req.body, vars);
  req.soapAction = subst(req.soapAction, vars);
  req.contentType = subst(req.contentType, vars);
  const sp = (arr) => arr.map((p) => ({ ...p, key: subst(p.key, vars), value: subst(p.value, vars) }));
  req.params = sp(req.params);
  req.headers = sp(req.headers);
  req.formData = sp(req.formData);
  if (req.auth) for (const k of ['token', 'username', 'password', 'key', 'value']) if (req.auth[k]) req.auth[k] = subst(req.auth[k], vars);
  return req;
}

/* ---------- Single request ---------- */
function mapRequest(item, prefix, collAuth, vars) {
  const r = item.request;
  const req = {
    name: (prefix ? prefix + ' / ' : '') + str(item.name || 'Untitled'),
    proto: 'rest', method: 'GET', url: '',
    params: [], headers: [], auth: { type: 'none' },
    bodyMode: 'none', body: '', contentType: '', soapAction: '', formData: [],
  };

  if (typeof r === 'string') { req.url = r; return applyVars(req, vars); }
  if (!r || typeof r !== 'object') return applyVars(req, vars);

  req.method = str(r.method || 'GET').toUpperCase();
  const u = mapUrl(r.url);
  req.url = u.url; req.params = u.params;
  req.headers = mapHeaders(r.header);
  req.auth = mapAuth(r.auth) || mapAuth(collAuth) || { type: 'none' };

  const body = mapBody(r);
  req.bodyMode = body.bodyMode || 'none';
  if (body.body != null) req.body = body.body;
  if (body.formData) req.formData = body.formData;
  if (body.contentType) req.contentType = body.contentType;
  if (body.soapAction != null) req.soapAction = body.soapAction;
  if (body.proto) req.proto = body.proto;

  return applyVars(req, vars);
}

/* ---------- Whole collection ---------- */
function fromPostman(doc) {
  const vars = {};
  (doc.variable || []).forEach((v) => { if (v && v.key != null) vars[v.key] = str(v.value); });
  const collAuth = doc.auth || null;

  const requests = [];
  (function walk(items, prefix) {
    for (const it of items || []) {
      if (!it) continue;
      if (Array.isArray(it.item)) {
        walk(it.item, (prefix ? prefix + ' / ' : '') + str(it.name || ''));
      } else if (it.request) {
        requests.push(mapRequest(it, prefix, collAuth, vars));
      }
    }
  })(doc.item, '');

  return { name: (doc.info && doc.info.name) || 'Imported collection', requests };
}

module.exports = { isPostman, fromPostman };
