'use strict';

// Load .env if present (no hard dependency on dotenv).
try {
  require('node:fs').accessSync(require('node:path').resolve(__dirname, '..', '.env'));
  loadDotEnv(require('node:path').resolve(__dirname, '..', '.env'));
} catch {
  /* no .env file, rely on real env vars */
}

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');

const auth = require('./auth');
const { executeHttp } = require('./executors/http');
const { executeFtp } = require('./executors/ftp');
const collections = require('./collections');
const flx = require('./flx');
const socks = require('./socks');
const { isPostman, fromPostman } = require('./postman');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_BODY_MB = parseInt(process.env.MAX_BODY_MB || '50', 10);

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: `${MAX_BODY_MB + 5}mb` }));

// ---------- Public auth endpoints ----------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = auth.issueToken(username);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: auth.isAuthenticated(req) });
});

// ---------- Protected API ----------

const api = express.Router();
api.use(auth.requireAuth);

// Execute an HTTP / HTTPS / SOAP request server-side.
api.post('/execute', async (req, res) => {
  try {
    const result = await executeHttp(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Execute an FTP / SFTP operation server-side.
api.post('/ftp', async (req, res) => {
  try {
    const result = await executeFtp(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- Flx (shared) collections, read-only from S3 -----

api.get('/flx/collections', async (_req, res) => {
  res.json(await flx.getCollections(false));
});

api.post('/flx/refresh', async (_req, res) => {
  res.json(await flx.getCollections(true));
});

// Convert any uploaded collection doc (Postman v2.x or Relay) to Relay shape,
// WITHOUT persisting. Used by the browser to import into personal (client-side) storage.
api.post('/convert', (req, res) => {
  try {
    let doc = req.body || {};
    if (isPostman(doc)) doc = fromPostman(doc);
    if (!doc || typeof doc !== 'object') throw new Error('Invalid document.');
    const rid = () => crypto.randomBytes(6).toString('hex');
    res.json({
      name: (doc.name || 'Imported collection').toString(),
      requests: Array.isArray(doc.requests) ? doc.requests.map((r) => ({ ...r, id: r.id || rid() })) : [],
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ----- Collections CRUD (legacy disk store; kept for optional server-side use) -----

api.get('/collections', async (_req, res) => {
  res.json(await collections.listCollections());
});

api.post('/collections', async (req, res) => {
  const doc = await collections.createCollection((req.body || {}).name);
  res.status(201).json(doc);
});

api.get('/collections/:id', async (req, res) => {
  const doc = await collections.getCollection(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Collection not found.' });
  res.json(doc);
});

api.patch('/collections/:id', async (req, res) => {
  const doc = await collections.renameCollection(req.params.id, (req.body || {}).name);
  if (!doc) return res.status(404).json({ error: 'Collection not found.' });
  res.json(doc);
});

api.delete('/collections/:id', async (req, res) => {
  const ok = await collections.deleteCollection(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Collection not found.' });
  res.json({ ok: true });
});

// ----- Requests within a collection -----

api.post('/collections/:id/requests', async (req, res) => {
  const saved = await collections.saveRequest(req.params.id, req.body || {});
  if (!saved) return res.status(404).json({ error: 'Collection not found.' });
  res.json(saved);
});

api.delete('/collections/:id/requests/:requestId', async (req, res) => {
  const ok = await collections.deleteRequest(req.params.id, req.params.requestId);
  if (!ok) return res.status(404).json({ error: 'Request not found.' });
  res.json({ ok: true });
});

// ----- Import / export -----

api.post('/collections/import', async (req, res) => {
  try {
    const doc = await collections.importCollection(req.body || {});
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use('/api', api);

// ---------- Static frontend ----------

app.use(express.static(path.resolve(__dirname, '..', 'public')));

// SPA fallback (any non-API GET returns the app shell).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Relay (Postman-clone) server listening on http://0.0.0.0:${PORT}`);
});

// Optional SOCKS5 egress proxy (for routing local integration jobs through this host).
socks.start();

// Minimal .env parser so we don't add a dependency just for local dev.
function loadDotEnv(file) {
  const fs = require('node:fs');
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
