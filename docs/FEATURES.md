# Features

Relay is a Postman-style API workbench where **requests execute on the server**, not in
the browser. Deploy the server on a host whose IP is whitelisted by your partners, and
developers anywhere can drive requests through it — without their own IPs being
whitelisted.

```
Browser (any developer, anywhere)
        │  HTTPS  (gated by a static username/password)
        ▼
Relay server  ── runs on the whitelisted host ──▶ target APIs / SOAP / FTP / SFTP
        │
        ├─ Flx (shared) collections ...... read-only, from S3
        ├─ Personal collections .......... in each developer's browser
        └─ Request history (14 days) ..... in each developer's browser
```

## Protocol support

### REST / HTTP(S)
- All methods (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS).
- Query params and headers with per-row enable/disable.
- Auth helpers: **Bearer**, **Basic**, **API key** (header or query), or none.
- Bodies: **JSON**, **raw** (custom content-type), **form url-encoded**, **none**.
- Response viewer: status, **time**, **size**, pretty-printed + syntax-highlighted JSON,
  full response headers, binary detection (not corrupted).

### SOAP / web services
- XML body mode with a **`SOAPAction`** helper.
- It's HTTP under the hood, so all header/auth options apply.

### FTP / FTPS / SFTP
- Operations: **list directory**, **download file**, **upload text**.
- Directory listing is interactive: **double-click a folder to open it**, **double-click a
  file to download it** (binary-safe). A breadcrumb shows the current path.
- Passive-mode transfers; explicit FTPS on port 21, implicit FTPS on 990, SFTP on 22.
- Hosts are whitespace/zero-width normalized, and DNS failures report the exact host and
  length (so a bad paste is obvious).

## Collections

### Flx — shared (read-only)
- Loaded by the server from an **S3 bucket/prefix** and shown to every user.
- Accepts **Relay exports or raw Postman v2.x exports** — both auto-converted.
- Refresh on demand (⟳) re-pulls from S3; cached in memory between pulls.
- Editing is done by updating the files in S3 (single source of truth for the team).

### Personal — per browser
- Create, rename, delete collections; save requests into them.
- **Import** a Relay or Postman JSON file; **export** any collection as JSON.
- Stored in the browser (`localStorage`), private to that person/browser.

### History — 14 days, per browser
- Every Send/Run is recorded with its **response**, stored in `IndexedDB`, auto-pruned
  after 14 days.
- Click any entry to reopen it in a tab; clear all with one click.

## Postman import
- Detects and converts **Postman Collection v2.0 / v2.1** exports:
  - URL split into base + query params; headers (with disabled state) preserved.
  - Bodies mapped: `raw` JSON→JSON, XML→raw, `urlencoded`→form.
  - Auth mapped: `bearer` / `basic` / `apikey` (OAuth/AWS/digest fall back to no-auth,
    keeping any auth headers).
  - **Folders flattened** into prefixed request names.
  - Collection **variables** (`{{var}}`) substituted where defined.
  - SOAP requests detected (via `SOAPAction`/envelope) and set to SOAP mode.

## Tabs
- Multiple open requests, Postman-style: **new (＋)**, **close (×)**, switch.
- Unsaved tabs show a dot; open tabs are remembered across reloads.
- Opening a Flx request shows a read-only banner — edits live only in the tab; **Save**
  copies it into a Personal collection.

## Access control
- The whole UI is gated by a **single static username/password** (from env).
- Session is a signed, http-only cookie with a configurable lifetime.
- Intended to sit on a private network / behind a proxy or VPN — it's a shared secret,
  not per-user identity.

## SOCKS5 egress bridge (for local integration jobs)
- An optional **authenticated SOCKS5 proxy** built into the server.
- Lets you run a real integration job (e.g. `WooCommerceGetOrders` from IntelliJ) on your
  laptop while its traffic **egresses from the whitelisted host**.
- Java routes *all* TCP through SOCKS, so REST/HTTPS, SFTP, and passive FTP/FTPS all exit
  from the host — with two JVM flags and **no code changes**.
- Username/password auth plus an optional IP/CIDR allowlist (e.g. a VPN subnet).
- `tools/ConnectivityCheck.java` validates the tunnel (egress IP, DB reachability,
  host:port probes) before you run a real job.

## What Relay is *not*
- Not a scripting/automation runner (no pre-request scripts, tests, or environments yet).
- Not a production file-transfer client (it does not verify SSH host keys or TLS certs).
- Not multi-user: personal data and history are per browser, not per account.
