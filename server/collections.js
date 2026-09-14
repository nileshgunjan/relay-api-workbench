'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isPostman, fromPostman } = require('./postman');

const DATA_DIR = process.env.DATA_DIR || './data';
const COLLECTIONS_DIR = path.resolve(DATA_DIR, 'collections');

async function ensureDir() {
  await fs.mkdir(COLLECTIONS_DIR, { recursive: true });
}

function newId() {
  return crypto.randomBytes(9).toString('hex');
}

function safeFile(id) {
  // ids are hex we generate, but guard against traversal anyway.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid collection id.');
  return path.join(COLLECTIONS_DIR, `${id}.json`);
}

/**
 * A collection document shape:
 * {
 *   id, name, createdAt, updatedAt,
 *   requests: [ { id, name, ...requestSpec } ]
 * }
 */

async function listCollections() {
  await ensureDir();
  const files = await fs.readdir(COLLECTIONS_DIR);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(COLLECTIONS_DIR, f), 'utf8');
      const doc = JSON.parse(raw);
      out.push(doc);
    } catch {
      /* skip corrupt files */
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return out;
}

async function getCollection(id) {
  await ensureDir();
  try {
    const raw = await fs.readFile(safeFile(id), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCollection(doc) {
  await ensureDir();
  doc.updatedAt = new Date().toISOString();
  const tmp = safeFile(doc.id) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fs.rename(tmp, safeFile(doc.id)); // atomic-ish replace
  return doc;
}

async function createCollection(name) {
  const doc = {
    id: newId(),
    name: (name || 'Untitled collection').trim() || 'Untitled collection',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requests: [],
  };
  return writeCollection(doc);
}

async function renameCollection(id, name) {
  const doc = await getCollection(id);
  if (!doc) return null;
  doc.name = (name || doc.name).trim() || doc.name;
  return writeCollection(doc);
}

async function deleteCollection(id) {
  await ensureDir();
  try {
    await fs.unlink(safeFile(id));
    return true;
  } catch {
    return false;
  }
}

async function saveRequest(collectionId, request) {
  const doc = await getCollection(collectionId);
  if (!doc) return null;
  if (!Array.isArray(doc.requests)) doc.requests = [];

  if (request.id) {
    const idx = doc.requests.findIndex((r) => r.id === request.id);
    if (idx >= 0) {
      doc.requests[idx] = { ...doc.requests[idx], ...request };
    } else {
      doc.requests.push(request);
    }
  } else {
    request.id = newId();
    doc.requests.push(request);
  }
  await writeCollection(doc);
  return request;
}

async function deleteRequest(collectionId, requestId) {
  const doc = await getCollection(collectionId);
  if (!doc) return false;
  const before = doc.requests.length;
  doc.requests = (doc.requests || []).filter((r) => r.id !== requestId);
  await writeCollection(doc);
  return doc.requests.length < before;
}

/**
 * Import an entire collection document (from export or another instance).
 * Assigns a fresh id to avoid clobbering.
 */
async function importCollection(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Invalid collection document.');
  // If this is a native Postman export, translate it into Relay's shape first.
  if (isPostman(doc)) doc = fromPostman(doc);
  const fresh = {
    id: newId(),
    name: (doc.name || 'Imported collection').toString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requests: Array.isArray(doc.requests)
      ? doc.requests.map((r) => ({ ...r, id: r.id || newId() }))
      : [],
  };
  return writeCollection(fresh);
}

module.exports = {
  listCollections,
  getCollection,
  createCollection,
  renameCollection,
  deleteCollection,
  saveRequest,
  deleteRequest,
  importCollection,
};
