'use strict';

/**
 * Flx (shared) collections, loaded read-only from S3.
 *
 * The server lists every *.json under FLX_S3_BUCKET / FLX_S3_PREFIX, fetches each,
 * converts it (Postman v2.x or Relay shape) into Relay's shape, and serves the
 * result to all authenticated users. Results are cached in memory for
 * FLX_CACHE_TTL_SECONDS; /api/flx/refresh forces a re-pull.
 *
 * Credentials come from the standard AWS provider chain — on the whitelisted AWS
 * host that's the instance/task IAM role, so no keys need to live in this app.
 */

const crypto = require('node:crypto');
const { isPostman, fromPostman } = require('./postman');

const BUCKET = process.env.FLX_S3_BUCKET || '';
const PREFIX = process.env.FLX_S3_PREFIX || '';
const REGION = process.env.FLX_S3_REGION || process.env.AWS_REGION || 'us-east-1';
const TTL_MS = parseInt(process.env.FLX_CACHE_TTL_SECONDS || '300', 10) * 1000;

let s3 = null;
let S3Client, ListObjectsV2Command, GetObjectCommand;

function ensureClient() {
  if (!BUCKET) return null;
  if (s3) return s3;
  // Lazy-require so the app still boots (and personal-only mode works) even if
  // the SDK isn't installed or S3 isn't configured.
  ({ S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3'));
  s3 = new S3Client({ region: REGION });
  return s3;
}

let cache = { at: 0, data: null };

function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

function normalize(doc, key) {
  const id = 'flx_' + hash(key);
  const name = (doc && doc.name) || key.split('/').pop().replace(/\.json$/i, '');
  const requests = Array.isArray(doc.requests)
    ? doc.requests.map((r, i) => ({ ...r, id: r.id || `${id}_r${i}` }))
    : [];
  return { id, name, source: 'flx', readonly: true, s3Key: key, requests };
}

async function pull() {
  const client = ensureClient();
  if (!client) return { configured: false, collections: [], error: 'FLX_S3_BUCKET is not set — Flx collections are disabled.' };

  const out = [];
  let ContinuationToken;
  try {
    do {
      const resp = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken }));
      for (const obj of resp.Contents || []) {
        if (!obj.Key || !/\.json$/i.test(obj.Key)) continue;
        try {
          const g = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
          const text = await g.Body.transformToString('utf-8');
          let doc = JSON.parse(text);
          if (isPostman(doc)) doc = fromPostman(doc);
          out.push(normalize(doc, obj.Key));
        } catch (e) {
          out.push({ id: 'flx_' + hash(obj.Key), name: obj.Key.split('/').pop(), source: 'flx', readonly: true, s3Key: obj.Key, requests: [], error: `Could not parse: ${e.message}` });
        }
      }
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (e) {
    return { configured: true, collections: [], error: `S3 error: ${e.message}` };
  }

  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { configured: true, collections: out, error: null, bucket: BUCKET, prefix: PREFIX };
}

async function getCollections(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL_MS) return cache.data;
  const data = await pull();
  cache = { at: now, data };
  return data;
}

module.exports = { getCollections, isConfigured: () => !!BUCKET };
