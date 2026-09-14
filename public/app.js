'use strict';

/* =========================================================================
   Relay client.
   - Flx collections: read-only, loaded from the server (S3-backed).
   - Personal collections: this browser only (localStorage).
   - History: this browser only (IndexedDB), auto-pruned to 14 days.
   - Multiple open request tabs, Postman-style.
   Every actual request still executes on the server.
   ========================================================================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const LS_PERSONAL = 'relay_personal_v1';
const LS_TABS = 'relay_tabs_v1';
const HISTORY_DAYS = 14;
const HISTORY_BODY_CAP = 200 * 1024; // cap stored response body per entry

/* ---------------- server API ---------------- */
const api = {
  async call(path, opts = {}) {
    const res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) { showLogin(); throw new Error('Not authenticated'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || 'Request failed');
    return data;
  },
  get: (p) => api.call(p),
  post: (p, body) => api.call(p, { method: 'POST', body: JSON.stringify(body || {}) }),
};

/* ---------------- request model ---------------- */
function emptyPair() { return { key: '', value: '', enabled: true }; }
function blankRequest() {
  return {
    id: null, name: 'New request', proto: 'rest', method: 'GET', url: '',
    params: [emptyPair()], headers: [emptyPair()], auth: { type: 'none' },
    bodyMode: 'none', body: '', contentType: '', soapAction: '', formData: [emptyPair()],
    ftp: { protocol: 'ftp', host: '', port: '', username: '', password: '', operation: 'list', path: '/', uploadContent: '' },
  };
}
function ensurePairs(arr) { const out = Array.isArray(arr) ? arr.filter((p) => p && (p.key || p.value)) : []; out.push(emptyPair()); return out; }
function normalizeRequest(r) {
  const base = blankRequest(); const m = { ...base, ...r };
  m.params = ensurePairs(r.params); m.headers = ensurePairs(r.headers); m.formData = ensurePairs(r.formData);
  m.auth = r.auth || { type: 'none' }; m.ftp = { ...base.ftp, ...(r.ftp || {}) };
  return m;
}
function trimPairs(pairs) { return (pairs || []).filter((p) => p && (p.key || p.value)); }
function newId() { return Math.random().toString(16).slice(2, 11); }

/* =========================================================================
   PERSONAL COLLECTIONS  (localStorage)
   ========================================================================= */
const Personal = {
  load() { try { return JSON.parse(localStorage.getItem(LS_PERSONAL) || '[]'); } catch { return []; } },
  saveAll(cols) { try { localStorage.setItem(LS_PERSONAL, JSON.stringify(cols)); } catch (e) { toast('Storage full: ' + e.message, 'err'); } },
  get(id) { return this.load().find((c) => c.id === id) || null; },
  create(name) {
    const cols = this.load();
    const doc = { id: newId(), name: (name || 'Untitled collection').trim() || 'Untitled collection', createdAt: Date.now(), updatedAt: Date.now(), requests: [] };
    cols.push(doc); this.saveAll(cols); return doc;
  },
  rename(id, name) { const cols = this.load(); const c = cols.find((x) => x.id === id); if (!c) return; c.name = (name || c.name).trim() || c.name; c.updatedAt = Date.now(); this.saveAll(cols); },
  del(id) { this.saveAll(this.load().filter((c) => c.id !== id)); },
  saveReq(cid, req) {
    const cols = this.load(); const c = cols.find((x) => x.id === cid); if (!c) return null;
    if (!Array.isArray(c.requests)) c.requests = [];
    if (req.id) { const i = c.requests.findIndex((r) => r.id === req.id); if (i >= 0) c.requests[i] = { ...c.requests[i], ...req }; else c.requests.push(req); }
    else { req.id = newId(); c.requests.push(req); }
    c.updatedAt = Date.now(); this.saveAll(cols); return req;
  },
  delReq(cid, rid) { const cols = this.load(); const c = cols.find((x) => x.id === cid); if (!c) return; c.requests = (c.requests || []).filter((r) => r.id !== rid); this.saveAll(cols); },
  import(doc) {
    const cols = this.load();
    const fresh = { id: newId(), name: (doc.name || 'Imported collection').toString(), createdAt: Date.now(), updatedAt: Date.now(),
      requests: Array.isArray(doc.requests) ? doc.requests.map((r) => ({ ...r, id: r.id || newId() })) : [] };
    cols.push(fresh); this.saveAll(cols); return fresh;
  },
};

/* =========================================================================
   FLX COLLECTIONS  (server, read-only)
   ========================================================================= */
const Flx = {
  collections: [], note: null,
  async load(force) {
    try {
      const res = force ? await api.post('/flx/refresh') : await api.get('/flx/collections');
      this.collections = res.collections || [];
      this.note = res.configured ? (res.error || null) : (res.error || 'Flx collections are not configured on the server.');
    } catch (e) { this.collections = []; this.note = 'Could not load Flx collections: ' + e.message; }
  },
};

/* =========================================================================
   HISTORY  (IndexedDB, 14-day retention)
   ========================================================================= */
const History = {
  db: null, available: true,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve) => {
      try {
        const r = indexedDB.open('relay', 1);
        r.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('history')) {
            const s = db.createObjectStore('history', { keyPath: 'id' });
            s.createIndex('ts', 'ts');
          }
        };
        r.onsuccess = () => { this.db = r.result; resolve(this.db); };
        r.onerror = () => { this.available = false; resolve(null); };
      } catch { this.available = false; resolve(null); }
    });
  },
  async add(entry) {
    const db = await this.open(); if (!db) return;
    try { const tx = db.transaction('history', 'readwrite'); tx.objectStore('history').put(entry); } catch {}
  },
  async all() {
    const db = await this.open(); if (!db) return [];
    return new Promise((resolve) => {
      try {
        const req = db.transaction('history', 'readonly').objectStore('history').getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts));
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  },
  async prune() {
    const db = await this.open(); if (!db) return;
    const cutoff = Date.now() - HISTORY_DAYS * 86400000;
    try {
      const store = db.transaction('history', 'readwrite').objectStore('history');
      const idx = store.index('ts');
      const range = IDBKeyRange.upperBound(cutoff);
      const cur = idx.openCursor(range);
      cur.onsuccess = (e) => { const c = e.target.result; if (c) { store.delete(c.primaryKey); c.continue(); } };
    } catch {}
  },
  async clear() {
    const db = await this.open(); if (!db) return;
    try { db.transaction('history', 'readwrite').objectStore('history').clear(); } catch {}
  },
};

/* =========================================================================
   TABS
   ========================================================================= */
const Tabs = {
  list: [], activeId: null,
  active() { return this.list.find((t) => t.id === this.activeId) || null; },
  cur() { const t = this.active(); return t ? t.req : blankRequest(); },
  add(req, source, response) {
    const tab = { id: newId(), req: req || blankRequest(), source: source || null, response: response || null, dirty: false };
    this.list.push(tab); this.activeId = tab.id; this.persist(); return tab;
  },
  focusOrOpen(matchFn, makeReq, source) {
    const found = this.list.find(matchFn);
    if (found) { this.activeId = found.id; this.persist(); return found; }
    return this.add(makeReq(), source);
  },
  close(id) {
    const idx = this.list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.list.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.list[idx] || this.list[idx - 1];
      this.activeId = next ? next.id : null;
    }
    if (!this.list.length) this.add(blankRequest(), null);
    this.persist();
  },
  markDirty() { const t = this.active(); if (t && !t.dirty) { t.dirty = true; renderTabs(); } this.persist(); },
  persist() {
    try {
      const slim = this.list.map((t) => ({ id: t.id, req: t.req, source: t.source, dirty: t.dirty }));
      localStorage.setItem(LS_TABS, JSON.stringify({ list: slim, activeId: this.activeId }));
    } catch {}
  },
  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_TABS) || 'null');
      if (saved && Array.isArray(saved.list) && saved.list.length) {
        this.list = saved.list.map((t) => ({ id: t.id || newId(), req: normalizeRequest(t.req || {}), source: t.source || null, response: null, dirty: !!t.dirty }));
        this.activeId = saved.activeId && this.list.some((t) => t.id === saved.activeId) ? saved.activeId : this.list[0].id;
        return true;
      }
    } catch {}
    return false;
  },
};

function tabLabelName(tab) {
  const r = tab.req;
  if (r.name && r.name !== 'New request') return r.name;
  if (r.proto === 'ftp') return r.ftp.host || 'FTP';
  return r.url ? r.url.replace(/^https?:\/\//, '').slice(0, 28) : 'New request';
}

function renderTabs() {
  const host = $('#tabs'); host.innerHTML = '';
  for (const tab of Tabs.list) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === Tabs.activeId ? ' active' : '');
    const label = tab.req.proto === 'ftp' ? 'FTP' : tab.req.method;
    el.innerHTML = `<span class="tab-method m-${esc(label)}">${esc(label)}</span>
      <span class="tab-name">${esc(tabLabelName(tab))}</span>
      ${tab.dirty ? '<span class="tab-dirty" title="Unsaved">•</span>' : ''}
      <button class="tab-close" title="Close">×</button>`;
    el.addEventListener('click', (e) => { if (e.target.classList.contains('tab-close')) return; Tabs.activeId = tab.id; Tabs.persist(); renderTabs(); renderBuilder(); });
    el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); Tabs.close(tab.id); renderTabs(); renderBuilder(); });
    host.appendChild(el);
  }
}

$('#btn-new-tab').addEventListener('click', () => { Tabs.add(blankRequest(), null); renderTabs(); renderBuilder(); });

/* =========================================================================
   AUTH
   ========================================================================= */
function showLogin() { $('#app').hidden = true; $('#login-screen').hidden = false; $('#login-username').focus(); }
function showApp() { $('#login-screen').hidden = true; $('#app').hidden = false; }

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error'); err.hidden = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Login failed');
    $('#who').textContent = data.username;
    await enterApp();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});
$('#btn-logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); showLogin(); });

async function enterApp() {
  showApp();
  if (!Tabs.restore()) Tabs.add(blankRequest(), null);
  renderTabs(); renderBuilder();
  History.prune();
  await refreshSidebar();
  await Flx.load(false); renderFlx();
}

/* =========================================================================
   SIDEBAR
   ========================================================================= */
let filterText = '';
$('#sidebar-filter').addEventListener('input', (e) => { filterText = e.target.value.toLowerCase(); renderFlx(); renderPersonal(); renderHistory(); });

function matchesFilter(r) {
  if (!filterText) return true;
  return (r.name || '').toLowerCase().includes(filterText) || (r.url || '').toLowerCase().includes(filterText);
}

// section collapse
$$('.side-section-head').forEach((h) => h.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  h.parentElement.classList.toggle('collapsed');
}));

async function refreshSidebar() { renderPersonal(); await renderHistory(); }

/* ----- Flx tree (read-only) ----- */
function renderFlx() {
  const host = $('#flx-tree'); host.innerHTML = '';
  if (Flx.note && !Flx.collections.length) {
    host.innerHTML = `<div class="section-note">${esc(Flx.note)}</div>`;
    return;
  }
  if (!Flx.collections.length) { host.innerHTML = '<div class="section-note">No shared collections found.</div>'; return; }
  for (const col of Flx.collections) {
    host.appendChild(collectionNode(col, {
      readonly: true,
      onOpen: (req) => openFlx(col, req),
    }));
  }
}

/* ----- Personal tree (editable) ----- */
function renderPersonal() {
  const host = $('#personal-tree'); host.innerHTML = '';
  const cols = Personal.load();
  if (!cols.length) { host.innerHTML = '<div class="section-note">No personal collections yet. Click ＋ to create one, or Import a Postman/Relay file.</div>'; return; }
  for (const col of cols) {
    host.appendChild(collectionNode(col, {
      readonly: false,
      onOpen: (req) => openPersonal(col, req),
      onAddReq: () => { const t = Tabs.add(blankRequest(), { scope: 'personal', colId: col.id }); renderTabs(); renderBuilder(); },
      onRename: () => { const n = prompt('Rename collection:', col.name); if (n && n !== col.name) { Personal.rename(col.id, n); renderPersonal(); } },
      onExport: () => exportPersonal(col),
      onDelete: () => { if (confirm(`Delete collection "${col.name}"?`)) { Personal.del(col.id); renderPersonal(); } },
      onDeleteReq: (req) => { if (confirm(`Delete request "${req.name}"?`)) { Personal.delReq(col.id, req.id); renderPersonal(); } },
    }));
  }
}

function collectionNode(col, opts) {
  const wrap = document.createElement('div'); wrap.className = 'collection';
  if (col._collapsed) wrap.classList.add('collapsed');
  const head = document.createElement('div'); head.className = 'collection-head';
  const actions = opts.readonly ? '' : `
    <span class="collection-actions">
      <button class="icon-btn" data-a="add" title="New request">＋</button>
      <button class="icon-btn" data-a="rename" title="Rename">✎</button>
      <button class="icon-btn" data-a="export" title="Export">⬆</button>
      <button class="icon-btn" data-a="delete" title="Delete">🗑</button>
    </span>`;
  head.innerHTML = `<span class="caret">▾</span><span class="collection-name">${esc(col.name)}</span>${actions}`;
  head.querySelector('.caret').addEventListener('click', (e) => { e.stopPropagation(); col._collapsed = !col._collapsed; wrap.classList.toggle('collapsed'); });
  head.querySelector('.collection-name').addEventListener('click', () => { col._collapsed = !col._collapsed; wrap.classList.toggle('collapsed'); });
  if (!opts.readonly) {
    head.querySelector('[data-a="add"]').addEventListener('click', (e) => { e.stopPropagation(); opts.onAddReq(); });
    head.querySelector('[data-a="rename"]').addEventListener('click', (e) => { e.stopPropagation(); opts.onRename(); });
    head.querySelector('[data-a="export"]').addEventListener('click', (e) => { e.stopPropagation(); opts.onExport(); });
    head.querySelector('[data-a="delete"]').addEventListener('click', (e) => { e.stopPropagation(); opts.onDelete(); });
  }
  wrap.appendChild(head);

  const list = document.createElement('div'); list.className = 'req-list';
  const reqs = (col.requests || []).filter(matchesFilter);
  if (col.error) { const n = document.createElement('div'); n.className = 'section-note err'; n.textContent = col.error; list.appendChild(n); }
  else if (!reqs.length) { const n = document.createElement('div'); n.className = 'req-item'; n.style.cursor = 'default'; n.innerHTML = '<span class="req-name" style="color:var(--text-dim)">No requests</span>'; list.appendChild(n); }
  for (const req of reqs) {
    const item = document.createElement('div'); item.className = 'req-item';
    const label = req.proto === 'ftp' ? 'FTP' : (req.method || 'GET');
    item.innerHTML = `<span class="req-method m-${esc(label)}">${esc(label)}</span>
      <span class="req-name">${esc(req.name || req.url || 'Untitled')}</span>
      ${opts.readonly ? '' : '<button class="req-del icon-btn" title="Delete">🗑</button>'}`;
    item.addEventListener('click', () => opts.onOpen(req));
    if (!opts.readonly) item.querySelector('.req-del').addEventListener('click', (e) => { e.stopPropagation(); opts.onDeleteReq(req); });
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

/* ----- History list ----- */
async function renderHistory() {
  const host = $('#history-list'); host.innerHTML = '';
  if (!History.available) { host.innerHTML = '<div class="section-note">History unavailable in this browser mode.</div>'; return; }
  const items = await History.all();
  const shown = items.filter((h) => !filterText || (h.url || '').toLowerCase().includes(filterText) || (h.name || '').toLowerCase().includes(filterText));
  if (!shown.length) { host.innerHTML = '<div class="section-note">No requests yet.</div>'; return; }
  for (const h of shown.slice(0, 200)) {
    const el = document.createElement('div'); el.className = 'hist-item';
    const label = h.proto === 'ftp' ? 'FTP' : (h.method || 'GET');
    const statusTxt = h.ok ? (h.status || 'OK') : 'ERR';
    el.innerHTML = `<span class="hist-status ${h.ok ? 'ok' : 'err'}">${esc(String(statusTxt))}</span>
      <div class="hist-main">
        <div class="hist-url"><span class="hist-method m-${esc(label)}">${esc(label)}</span> ${esc(h.url || h.name || '')}</div>
        <div class="hist-time">${new Date(h.ts).toLocaleString()} · ${h.timeMs != null ? h.timeMs + ' ms' : ''}</div>
      </div>`;
    el.addEventListener('click', () => openHistory(h));
    host.appendChild(el);
  }
}

$('#btn-clear-history').addEventListener('click', async () => { if (confirm('Clear all request history?')) { await History.clear(); renderHistory(); } });
$('#btn-refresh-flx').addEventListener('click', async () => { toast('Refreshing Flx…'); await Flx.load(true); renderFlx(); toast('Flx refreshed', 'ok'); });

/* ----- open helpers ----- */
function openPersonal(col, req) {
  Tabs.focusOrOpen(
    (t) => t.source && t.source.scope === 'personal' && t.source.colId === col.id && t.source.reqId === req.id,
    () => normalizeRequest(JSON.parse(JSON.stringify(req))),
    { scope: 'personal', colId: col.id, reqId: req.id }
  );
  renderTabs(); renderBuilder();
}
function openFlx(col, req) {
  Tabs.focusOrOpen(
    (t) => t.source && t.source.scope === 'flx' && t.source.colId === col.id && t.source.reqId === req.id,
    () => normalizeRequest(JSON.parse(JSON.stringify(req))),
    { scope: 'flx', colId: col.id, reqId: req.id }
  );
  renderTabs(); renderBuilder();
}
function openHistory(h) {
  const tab = Tabs.add(normalizeRequest(JSON.parse(JSON.stringify(h.request || {}))), null, h.response || null);
  renderTabs(); renderBuilder();
  if (h.response) { if (h.proto === 'ftp') renderFtpResponse(h.response); else renderHttpResponse(h.response); }
}

/* =========================================================================
   IMPORT / EXPORT (personal)
   ========================================================================= */
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const relay = await api.post('/convert', raw);   // server converts Postman/Relay -> Relay shape
    Personal.import(relay);
    renderPersonal();
    toast(`Imported "${relay.name}" (${(relay.requests || []).length} requests)`, 'ok');
  } catch (ex) { toast('Import failed: ' + ex.message, 'err'); }
  e.target.value = '';
});

function exportPersonal(col) {
  const blob = new Blob([JSON.stringify(col, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${(col.name || 'collection').replace(/[^a-z0-9-_]+/gi, '_')}.json`; a.click(); URL.revokeObjectURL(a.href);
}

['#btn-new-collection', '#btn-new-collection-2'].forEach((sel) => $(sel).addEventListener('click', () => {
  const name = prompt('Personal collection name:', 'New collection'); if (name === null) return;
  Personal.create(name); renderPersonal(); toast('Collection created', 'ok');
}));

/* =========================================================================
   BUILDER  (renders the ACTIVE TAB's request)
   ========================================================================= */
function renderBuilder() {
  const c = Tabs.cur();
  $('#readonly-banner').hidden = !(Tabs.active() && Tabs.active().source && Tabs.active().source.scope === 'flx');

  $$('.proto-btn').forEach((b) => b.classList.toggle('active', b.dataset.proto === c.proto));
  const isFtp = c.proto === 'ftp';
  $('#http-line').hidden = isFtp; $('#ftp-line').hidden = !isFtp;
  $('#http-config').hidden = isFtp; $('#ftp-config').hidden = !isFtp;
  $('#soap-mode-label').hidden = c.proto !== 'soap';
  if (c.proto === 'soap' && c.bodyMode === 'none') c.bodyMode = 'soap';

  if (!isFtp) {
    $('#method').value = c.method; $('#url').value = c.url;
    renderKV('#params-editor', c.params, 'params'); renderKV('#headers-editor', c.headers, 'headers');
    renderAuth(); renderBody();
  } else {
    $('#ftp-protocol').value = c.ftp.protocol; $('#ftp-host').value = c.ftp.host; $('#ftp-port').value = c.ftp.port;
    $('#ftp-username').value = c.ftp.username; $('#ftp-password').value = c.ftp.password;
    $('#ftp-operation').value = c.ftp.operation; $('#ftp-path').value = c.ftp.path;
    $('#ftp-upload-content').value = c.ftp.uploadContent || ''; updateFtpOperationUI();
  }

  // Restore this tab's last response (or clear).
  const t = Tabs.active();
  if (t && t.response) { if (t.req.proto === 'ftp') renderFtpResponse(t.response); else renderHttpResponse(t.response); }
  else clearResponse();
}

function renderKV(selector, pairs, field) {
  const host = $(selector); host.innerHTML = '';
  pairs.forEach((pair, idx) => {
    const row = document.createElement('div'); row.className = 'kv-row';
    row.innerHTML = `<input type="checkbox" ${pair.enabled !== false ? 'checked' : ''} />
      <input class="kv-key" placeholder="Key" value="${escAttr(pair.key)}" />
      <input class="kv-val" placeholder="Value" value="${escAttr(pair.value)}" />
      <button class="kv-del" title="Remove">×</button>`;
    const [chk, key, val] = row.querySelectorAll('input');
    chk.addEventListener('change', () => { pair.enabled = chk.checked; Tabs.markDirty(); });
    key.addEventListener('input', () => { pair.key = key.value; Tabs.markDirty(); maybeGrow(pairs, idx, field); });
    val.addEventListener('input', () => { pair.value = val.value; Tabs.markDirty(); maybeGrow(pairs, idx, field); });
    row.querySelector('.kv-del').addEventListener('click', () => { pairs.splice(idx, 1); if (!pairs.length) pairs.push(emptyPair()); renderKV(selector, pairs, field); Tabs.markDirty(); });
    host.appendChild(row);
  });
}
function maybeGrow(pairs, idx, field) {
  if (idx === pairs.length - 1 && (pairs[idx].key || pairs[idx].value)) {
    pairs.push(emptyPair());
    const map = { params: '#params-editor', headers: '#headers-editor', form: '#form-editor' };
    renderKV(map[field], pairs, field);
  }
}
function renderAuth() {
  const a = Tabs.cur().auth; $('#auth-type').value = a.type || 'none';
  $('#auth-bearer').hidden = a.type !== 'bearer'; $('#auth-basic').hidden = a.type !== 'basic'; $('#auth-apikey').hidden = a.type !== 'apikey';
  $('#auth-token').value = a.token || ''; $('#auth-username').value = a.username || ''; $('#auth-password').value = a.password || '';
  $('#auth-key').value = a.key || ''; $('#auth-value').value = a.value || ''; $('#auth-in').value = a.in || 'header';
}
function renderBody() {
  const c = Tabs.cur();
  $$('input[name="bodyMode"]').forEach((r) => { r.checked = r.value === c.bodyMode; });
  const isForm = c.bodyMode === 'form'; const isText = ['json', 'raw', 'soap'].includes(c.bodyMode);
  $('#body-text').hidden = !isText; $('#form-editor').hidden = !isForm;
  $('#soap-action-row').hidden = c.bodyMode !== 'soap'; $('#raw-ctype-row').hidden = c.bodyMode !== 'raw';
  $('#btn-beautify').hidden = c.bodyMode !== 'json';
  if (isText) $('#body-text').value = c.body || ''; if (isForm) renderKV('#form-editor', c.formData, 'form');
  $('#soap-action').value = c.soapAction || ''; $('#raw-ctype').value = c.contentType || '';
}
function updateFtpOperationUI() {
  const op = $('#ftp-operation').value; $('#ftp-upload-row').hidden = op !== 'upload';
  $('#ftp-path-label').textContent = op === 'list' ? 'Remote directory' : 'Remote file path';
}

/* ----- builder wiring (writes to active tab) ----- */
$$('.proto-btn').forEach((b) => b.addEventListener('click', () => {
  const c = Tabs.cur(); c.proto = b.dataset.proto;
  if (b.dataset.proto === 'soap' && c.bodyMode === 'none') c.bodyMode = 'soap';
  if (b.dataset.proto === 'rest' && c.bodyMode === 'soap') c.bodyMode = 'none';
  Tabs.markDirty(); renderTabs(); renderBuilder();
}));
$('#method').addEventListener('change', (e) => { Tabs.cur().method = e.target.value; Tabs.markDirty(); renderTabs(); });
$('#url').addEventListener('input', (e) => { Tabs.cur().url = e.target.value; Tabs.markDirty(); });
$('#url').addEventListener('blur', renderTabs);
$$('.ctab').forEach((t) => t.addEventListener('click', () => {
  $$('.ctab').forEach((x) => x.classList.remove('active')); t.classList.add('active');
  $$('.ctab-panel').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
}));
$('#auth-type').addEventListener('change', (e) => { Tabs.cur().auth.type = e.target.value; renderAuth(); Tabs.markDirty(); });
['token', 'username', 'password', 'key', 'value', 'in'].forEach((f) => $('#auth-' + f).addEventListener('input', (e) => { Tabs.cur().auth[f] = e.target.value; Tabs.markDirty(); }));
$$('input[name="bodyMode"]').forEach((r) => r.addEventListener('change', () => { Tabs.cur().bodyMode = r.value; renderBody(); Tabs.markDirty(); }));
$('#body-text').addEventListener('input', (e) => { Tabs.cur().body = e.target.value; Tabs.markDirty(); });
$('#soap-action').addEventListener('input', (e) => { Tabs.cur().soapAction = e.target.value; Tabs.markDirty(); });
$('#raw-ctype').addEventListener('input', (e) => { Tabs.cur().contentType = e.target.value; Tabs.markDirty(); });
$('#btn-beautify').addEventListener('click', () => {
  const c = Tabs.cur();
  try { c.body = JSON.stringify(JSON.parse(c.body), null, 2); $('#body-text').value = c.body; Tabs.markDirty(); }
  catch (ex) { toast('Invalid JSON: ' + ex.message, 'err'); }
});
$('#ftp-protocol').addEventListener('change', (e) => { Tabs.cur().ftp.protocol = e.target.value; Tabs.markDirty(); });
$('#ftp-host').addEventListener('input', (e) => { Tabs.cur().ftp.host = e.target.value; Tabs.markDirty(); });
$('#ftp-port').addEventListener('input', (e) => { Tabs.cur().ftp.port = e.target.value; Tabs.markDirty(); });
$('#ftp-username').addEventListener('input', (e) => { Tabs.cur().ftp.username = e.target.value; Tabs.markDirty(); });
$('#ftp-password').addEventListener('input', (e) => { Tabs.cur().ftp.password = e.target.value; Tabs.markDirty(); });
$('#ftp-operation').addEventListener('change', (e) => { Tabs.cur().ftp.operation = e.target.value; updateFtpOperationUI(); Tabs.markDirty(); });
$('#ftp-path').addEventListener('input', (e) => { Tabs.cur().ftp.path = e.target.value; Tabs.markDirty(); });
$('#ftp-upload-content').addEventListener('input', (e) => { Tabs.cur().ftp.uploadContent = e.target.value; Tabs.markDirty(); });
$$('.rtab').forEach((t) => t.addEventListener('click', () => {
  $$('.rtab').forEach((x) => x.classList.remove('active')); t.classList.add('active');
  $('#response-body').hidden = t.dataset.rtab !== 'body'; $('#response-headers').hidden = t.dataset.rtab !== 'headers';
}));

/* =========================================================================
   SEND / RUN  (+ history)
   ========================================================================= */
$('#btn-send').addEventListener('click', sendHttp);
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendHttp(); });
$('#btn-ftp-send').addEventListener('click', runFtp);

async function sendHttp() {
  const c = Tabs.cur(); if (!c.url.trim()) { toast('Enter a URL', 'err'); return; }
  setSending(true, '#btn-send');
  const spec = { method: c.method, url: c.url, params: c.params, headers: c.headers, auth: c.auth,
    bodyMode: c.bodyMode, body: c.body, contentType: c.contentType, soapAction: c.soapAction, formData: c.formData };
  try {
    const result = await api.post('/execute', spec);
    stashResponse(result);
    renderHttpResponse(result);
    recordHistory(c, spec, result, 'rest');
  } catch (ex) { renderError(ex.message); }
  finally { setSending(false, '#btn-send', 'Send'); }
}
async function runFtp() {
  const c = Tabs.cur(); const f = c.ftp; if (!f.host.trim()) { toast('Enter a host', 'err'); return; }
  setSending(true, '#btn-ftp-send');
  const spec = { protocol: f.protocol, host: (f.host || '').trim(), port: (f.port || '').toString().trim(),
    username: (f.username || '').trim(), password: f.password,
    operation: f.operation, path: (f.path || '').trim(), uploadContent: f.uploadContent, uploadEncoding: 'utf8' };
  try {
    const result = await api.post('/ftp', spec);
    stashResponse(result);
    renderFtpResponse(result);
    recordHistory(c, spec, result, 'ftp');
  } catch (ex) { renderError(ex.message); }
  finally { setSending(false, '#btn-ftp-send', 'Run'); }
}
function stashResponse(result) { const t = Tabs.active(); if (t) t.response = result; }
function setSending(on, sel, label) { const b = $(sel); b.disabled = on; b.innerHTML = on ? '<span class="spinner"></span>' : label; }

/* ----- FTP listing navigation / download (double-click) ----- */
function joinPath(base, name) {
  if (name === '.') return base || '/';
  if (name === '..') return parentPath(base);
  const b = (base || '/').replace(/\/+$/, '');
  return (b || '') + '/' + name;
}
function parentPath(base) {
  const b = (base || '/').replace(/\/+$/, '');
  const idx = b.lastIndexOf('/');
  return idx <= 0 ? '/' : b.slice(0, idx);
}
function navigateFtp(newPath) {
  const c = Tabs.cur();
  c.ftp.path = newPath; c.ftp.operation = 'list';
  $('#ftp-path').value = newPath; $('#ftp-operation').value = 'list'; updateFtpOperationUI();
  Tabs.markDirty();
  runFtp();
}
async function downloadFtpFile(filePath, fileName) {
  const f = Tabs.cur().ftp;
  const spec = { protocol: f.protocol, host: (f.host || '').trim(), port: (f.port || '').toString().trim(),
    username: (f.username || '').trim(), password: f.password, operation: 'download', path: filePath, uploadEncoding: 'utf8' };
  toast('Downloading ' + fileName + '…');
  try {
    const r = await api.post('/ftp', spec);
    if (!r.ok) { toast('Download failed: ' + r.error, 'err'); recordHistory(Tabs.cur(), spec, r, 'ftp'); return; }
    let blob;
    if (r.bodyEncoding === 'base64') {
      const bin = atob(r.body || '');
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      blob = new Blob([arr], { type: 'application/octet-stream' });
    } else {
      blob = new Blob([r.body || ''], { type: 'text/plain' });
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; a.click(); URL.revokeObjectURL(a.href);
    toast('Downloaded ' + fileName, 'ok');
    recordHistory(Tabs.cur(), spec, r, 'ftp');
  } catch (e) { toast('Download failed: ' + e.message, 'err'); }
}

function recordHistory(reqModel, spec, result, proto) {
  const url = proto === 'ftp' ? `${spec.protocol}://${spec.host}${spec.path || ''}` : spec.url;
  const capped = { ...result };
  if (typeof capped.body === 'string' && capped.body.length > HISTORY_BODY_CAP) capped.body = capped.body.slice(0, HISTORY_BODY_CAP) + '\n…(truncated in history)';
  const entry = {
    id: newId(), ts: Date.now(), proto,
    method: proto === 'ftp' ? spec.operation : spec.method,
    name: reqModel.name || url, url,
    ok: !!result.ok, status: result.status != null ? result.status : (result.ok ? 'OK' : 'ERR'),
    timeMs: result.timeMs, request: JSON.parse(JSON.stringify(reqModel)), response: capped,
  };
  History.add(entry).then(() => renderHistory());
}

/* =========================================================================
   RESPONSE RENDERING
   ========================================================================= */
function clearResponse() {
  $('#response-meta').innerHTML = ''; $('#response-tabs').hidden = true; $('#response-headers').hidden = true;
  const host = $('#response-body'); host.hidden = false; host.innerHTML = '<div class="response-empty">Send a request to see the response here.</div>';
}
function renderHttpResponse(r) {
  const meta = $('#response-meta');
  if (!r.ok) { renderError(r.error || 'Request failed', r.timeMs); return; }
  const cls = r.status < 400 ? 'status-ok' : 'status-err';
  meta.innerHTML = `<span class="${cls}">${r.status} ${esc(r.statusText || '')}</span><span class="meta-dim">${r.timeMs} ms</span><span class="meta-dim">${fmtBytes(r.sizeBytes)}</span>`;
  $('#response-tabs').hidden = false;
  const host = $('#response-body'); host.hidden = false;
  if (r.bodyEncoding === 'base64') host.innerHTML = `<div class="response-empty">Binary response (${fmtBytes(r.sizeBytes)}, ${esc(r.contentType || '')}). Not previewed.</div>`;
  else if (/json/i.test(r.contentType || '')) host.innerHTML = '<pre>' + highlightJson(r.body) + '</pre>';
  else host.innerHTML = '<pre>' + esc(r.body || '') + '</pre>';
  const rows = Object.entries(r.headers || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  $('#response-headers').innerHTML = `<table>${rows}</table>`;
  resetResponseTab();
}
function renderFtpResponse(r) {
  const meta = $('#response-meta');
  if (!r.ok) { renderError(r.error || 'Operation failed', r.timeMs); return; }
  meta.innerHTML = `<span class="status-ok">OK</span><span class="meta-dim">${r.timeMs} ms</span>`;
  $('#response-tabs').hidden = true; $('#response-headers').hidden = true;
  const host = $('#response-body'); host.hidden = false;
  if (r.operation === 'list') {
    const base = r.path || '/';
    const rows = (r.entries || []).map((e) => `<tr class="ftp-row" data-type="${esc(e.type)}" data-name="${escAttr(e.name)}" title="${e.type === 'dir' ? 'Double-click to open' : e.type === 'file' ? 'Double-click to download' : ''}">
      <td class="${e.type === 'dir' ? 'fname-dir' : ''}">${e.type === 'dir' ? '📁 ' : e.type === 'link' ? '🔗 ' : '📄 '}${esc(e.name)}</td>
      <td>${e.type}</td><td>${e.type === 'file' ? fmtBytes(e.size) : ''}</td>
      <td class="meta-dim">${e.modifiedAt ? new Date(e.modifiedAt).toLocaleString() : ''}</td></tr>`).join('');
    host.innerHTML = `<div class="ftp-crumb">📂 ${esc(base)}</div>
      <table class="ftp-listing"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="meta-dim">Empty directory</td></tr>'}</tbody></table>
      <div class="section-note">Double-click a folder to open it · double-click a file to download it.</div>`;
    host.querySelectorAll('tr.ftp-row').forEach((tr) => {
      tr.addEventListener('dblclick', () => {
        const type = tr.dataset.type, name = tr.dataset.name;
        if (type === 'dir') navigateFtp(joinPath(base, name));
        else if (type === 'file') downloadFtpFile(joinPath(base, name), name);
      });
    });
  } else if (r.operation === 'download') {
    meta.innerHTML += `<span class="meta-dim">${fmtBytes(r.sizeBytes)}</span>`;
    if (r.bodyEncoding === 'base64') host.innerHTML = `<div class="response-empty">Binary file (${fmtBytes(r.sizeBytes)}). Not previewed.</div>`;
    else host.innerHTML = '<pre>' + esc(r.body || '') + '</pre>';
  } else if (r.operation === 'upload') {
    host.innerHTML = `<div class="response-empty" style="color:var(--green)">✓ ${esc(r.message)} (${fmtBytes(r.sizeBytes)} to ${esc(r.path)})</div>`;
  }
}
function renderError(msg, timeMs) {
  $('#response-meta').innerHTML = `<span class="status-err">Error</span>` + (timeMs != null ? `<span class="meta-dim">${timeMs} ms</span>` : '');
  $('#response-tabs').hidden = true; $('#response-headers').hidden = true;
  const host = $('#response-body'); host.hidden = false; host.innerHTML = `<div class="response-error">${esc(msg)}</div>`;
}
function resetResponseTab() { $$('.rtab').forEach((x, i) => x.classList.toggle('active', i === 0)); $('#response-body').hidden = false; $('#response-headers').hidden = true; }

/* =========================================================================
   SAVE  (into a Personal collection)
   ========================================================================= */
$('#btn-save').addEventListener('click', saveRequest);
$('#btn-save-ftp').addEventListener('click', saveRequest);

function saveRequest() {
  const t = Tabs.active(); if (!t) return;
  const c = t.req;
  let colId = (t.source && t.source.scope === 'personal') ? t.source.colId : null;

  if (!colId) {
    const cols = Personal.load();
    if (!cols.length) {
      const name = prompt('No personal collections yet. Name for a new one:', 'My collection'); if (name === null) return;
      colId = Personal.create(name).id;
    } else {
      const choice = pickPersonal(cols); if (choice === null) return;
      colId = choice === '__new__' ? (() => { const n = prompt('New collection name:', 'My collection'); return n === null ? null : Personal.create(n).id; })() : choice;
      if (!colId) return;
    }
  }

  const name = prompt('Request name:', c.name && c.name !== 'New request' ? c.name : (c.url || 'Untitled request')); if (name === null) return;
  c.name = name;
  const payload = JSON.parse(JSON.stringify(c));
  payload.params = trimPairs(payload.params); payload.headers = trimPairs(payload.headers); payload.formData = trimPairs(payload.formData);
  if (!(t.source && t.source.scope === 'personal')) payload.id = null; // saving a Flx/new request creates a new personal entry
  const saved = Personal.saveReq(colId, payload);
  c.id = saved.id;
  t.source = { scope: 'personal', colId, reqId: saved.id };
  t.dirty = false;
  renderPersonal(); renderTabs(); toast('Saved to Personal', 'ok');
}
function pickPersonal(cols) {
  const list = cols.map((col, i) => `${i + 1}. ${col.name}`).join('\n');
  const raw = prompt(`Save to which personal collection?\n${list}\n\nEnter a number, or 0 for a NEW collection:`, '1');
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  if (n === 0) return '__new__';
  if (n >= 1 && n <= cols.length) return cols[n - 1].id;
  return null;
}

/* =========================================================================
   HELPERS
   ========================================================================= */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
function fmtBytes(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(2) + ' MB'; }
function highlightJson(text) {
  let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  return esc(pretty).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, (m) => {
    let cls = 'tok-num';
    if (/^"/.test(m)) cls = /:$/.test(m) ? 'tok-key' : 'tok-str';
    else if (/true|false/.test(m)) cls = 'tok-bool';
    else if (/null/.test(m)) cls = 'tok-null';
    return `<span class="${cls}">${m}</span>`;
  });
}
let toastTimer;
function toast(msg, kind) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* =========================================================================
   BOOT
   ========================================================================= */
(async function boot() {
  try {
    const me = await fetch('/api/me').then((r) => r.json());
    if (me.authenticated) { await enterApp(); } else { showLogin(); }
  } catch { showLogin(); }
})();
