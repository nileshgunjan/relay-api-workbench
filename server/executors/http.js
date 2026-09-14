'use strict';

const axios = require('axios');
const { performance } = require('node:perf_hooks');

const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);
const MAX_BODY_MB = parseInt(process.env.MAX_BODY_MB || '50', 10);
const MAX_CONTENT_LENGTH = MAX_BODY_MB * 1024 * 1024;

/**
 * Turn an array of {key, value, enabled} pairs into a plain object.
 * Skips disabled/empty keys. Later duplicate keys win.
 */
function pairsToObject(pairs) {
  const out = {};
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs) {
    if (!p || p.enabled === false) continue;
    const key = (p.key || '').trim();
    if (!key) continue;
    out[key] = p.value == null ? '' : String(p.value);
  }
  return out;
}

/**
 * Apply an auth block to headers / query params.
 * Supported: none, bearer, basic, apikey (header or query).
 */
function applyAuth(auth, headers, params) {
  if (!auth || !auth.type || auth.type === 'none') return;

  if (auth.type === 'bearer' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth.type === 'basic') {
    const raw = `${auth.username || ''}:${auth.password || ''}`;
    headers['Authorization'] = 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
  } else if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') {
      params[auth.key] = auth.value || '';
    } else {
      headers[auth.key] = auth.value || '';
    }
  }
}

/**
 * Build the request body from the spec.
 * bodyMode: none | raw | json | form | soap
 */
function buildBody(spec, headers) {
  const mode = spec.bodyMode || 'none';

  if (mode === 'none') return undefined;

  if (mode === 'json') {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    // Send as-is (string). If the user typed valid JSON we still forward the raw text
    // so the server sees exactly what was authored.
    return spec.body || '';
  }

  if (mode === 'raw') {
    if (spec.contentType && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = spec.contentType;
    }
    return spec.body || '';
  }

  if (mode === 'soap') {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'text/xml; charset=utf-8';
    if (spec.soapAction && !hasHeader(headers, 'soapaction')) {
      headers['SOAPAction'] = spec.soapAction;
    }
    return spec.body || '';
  }

  if (mode === 'form') {
    // application/x-www-form-urlencoded
    const obj = pairsToObject(spec.formData);
    if (!hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return new URLSearchParams(obj).toString();
  }

  return undefined;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((h) => h.toLowerCase() === lower);
}

function approxSize(data) {
  try {
    if (data == null) return 0;
    if (Buffer.isBuffer(data)) return data.length;
    if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Execute an HTTP/HTTPS/SOAP request server-side.
 * Returns a normalized result object (never throws for HTTP-level errors like 4xx/5xx).
 */
async function executeHttp(spec) {
  const method = (spec.method || 'GET').toUpperCase();
  const url = (spec.url || '').trim();
  if (!url) return { ok: false, error: 'URL is required.' };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }

  const headers = pairsToObject(spec.headers);
  const params = pairsToObject(spec.params);
  applyAuth(spec.auth, headers, params);

  let data;
  try {
    data = buildBody(spec, headers);
  } catch (e) {
    return { ok: false, error: `Failed to build request body: ${e.message}` };
  }

  const start = performance.now();
  try {
    const resp = await axios.request({
      method,
      url,
      params,
      headers,
      data,
      timeout: TIMEOUT_MS,
      // We want the raw response regardless of status code.
      validateStatus: () => true,
      // Do not auto-follow so behaviour is predictable; can be toggled later.
      maxRedirects: spec.followRedirects === false ? 0 : 5,
      responseType: 'arraybuffer',
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_CONTENT_LENGTH,
      decompress: true,
    });
    const elapsedMs = Math.round(performance.now() - start);

    const buf = Buffer.from(resp.data);
    const contentType = (resp.headers['content-type'] || '').toString();
    const isText =
      /json|xml|text|javascript|html|urlencoded|csv|yaml|graphql/i.test(contentType) ||
      buf.length === 0;

    return {
      ok: true,
      status: resp.status,
      statusText: resp.statusText || '',
      timeMs: elapsedMs,
      sizeBytes: buf.length,
      headers: flattenHeaders(resp.headers),
      contentType,
      // For text-ish responses return the string; for binary return base64 with a flag.
      body: isText ? buf.toString('utf8') : buf.toString('base64'),
      bodyEncoding: isText ? 'utf8' : 'base64',
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      ok: false,
      timeMs: elapsedMs,
      error: describeAxiosError(err),
    };
  }
}

function flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function describeAxiosError(err) {
  if (err.code === 'ECONNABORTED') return `Request timed out after ${TIMEOUT_MS} ms.`;
  if (err.code === 'ENOTFOUND') return `DNS lookup failed: host not found (${err.hostname || ''}).`;
  if (err.code === 'ECONNREFUSED') return 'Connection refused by the target server.';
  if (err.code === 'ETIMEDOUT') return 'Connection timed out.';
  if (err.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' || err.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
    return `Response exceeded the ${MAX_BODY_MB} MB limit.`;
  }
  if (err.response) {
    return `HTTP error ${err.response.status}`;
  }
  return err.message || 'Unknown request error.';
}

module.exports = { executeHttp, pairsToObject };
