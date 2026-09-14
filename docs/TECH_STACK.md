# Technology Stack

Relay is a small, dependency-light client/server application. The guiding principle is
that the **browser is a thin client** and **all outbound network work happens on the
server**, so requests originate from the server's (whitelisted) IP rather than the
developer's machine.

## Overview

| Layer | Technology | Why |
|-------|-----------|-----|
| Server runtime | **Node.js ≥ 20** (CommonJS) | Single language end to end, tiny footprint, first-class HTTP/TCP libraries. |
| Web framework | **Express 4** | Minimal routing + static file serving; no heavier framework needed. |
| HTTP/SOAP executor | **axios** | Arbitrary methods, header control, timing/size capture, binary-safe responses. |
| FTP / FTPS | **basic-ftp** | Pure-JS FTP with explicit/implicit TLS. |
| SFTP | **ssh2-sftp-client** | SSH-based file transfer (list/get/put). |
| Shared collections | **@aws-sdk/client-s3** | Reads read-only "Flx" collections from an S3 bucket/prefix. |
| Auth | **jsonwebtoken** + **cookie-parser** | Static single credential exchanged for a signed, http-only session cookie. |
| Egress bridge | **Node `net` (no dependency)** | Custom authenticated SOCKS5 proxy so local jobs can route out through this host. |
| Frontend | **Vanilla HTML/CSS/JS** (no build step) | Zero toolchain; served straight from `public/`. |
| Client storage | **localStorage** + **IndexedDB** | Personal collections (localStorage), request history (IndexedDB). |
| Packaging | **Docker** (`node:20-alpine`) + **docker-compose** | One artifact, runs anywhere; data persisted via a bind-mounted volume. |
| Diagnostics | **Standalone JDK tool** (`tools/ConnectivityCheck.java`) | Validates the SOCKS bridge (egress IP, DB, host:port) from a JVM like the real jobs. |

There is **no frontend framework and no build/bundler step** — the UI is a single
`index.html` + `app.js` + `style.css`, loaded directly. This keeps the deploy trivial
and the surface area small.

## Server modules (`server/`)

| File | Responsibility |
|------|----------------|
| `index.js` | Express app: routes, static serving, `.env` loader, starts HTTP + (optional) SOCKS. |
| `auth.js` | Static-credential verification, signed http-only session cookie, auth middleware. |
| `executors/http.js` | Executes REST/SOAP requests (params, headers, auth, bodies) and normalizes the response (status, timing, size, headers, text/base64 body). |
| `executors/ftp.js` | Executes FTP/FTPS/SFTP operations (list/download/upload); normalizes hosts, improves DNS errors. |
| `collections.js` | JSON-on-disk collection CRUD (legacy/optional server-side store) + Postman import hook. |
| `postman.js` | Converts Postman Collection v2.0/v2.1 exports into Relay's request shape. |
| `flx.js` | Lists + fetches shared collections from S3, converts and caches them (read-only). |
| `socks.js` | Authenticated SOCKS5 proxy (RFC 1928 + username/password RFC 1929) with optional IP/CIDR allowlist. |

## Frontend (`public/`)

| File | Responsibility |
|------|----------------|
| `index.html` | App shell: login gate, sidebar (Flx / Personal / History), request builder, response viewer. |
| `app.js` | All client logic: tabs, builder state, personal store (localStorage), history (IndexedDB), Flx loading, send/run, FTP listing navigation. |
| `style.css` | Dark, Postman-like theme; tokenized colors. |

## Data & persistence model

| Data | Where it lives | Scope |
|------|----------------|-------|
| **Flx (shared) collections** | S3 bucket/prefix (server reads, caches in memory) | Everyone, read-only |
| **Personal collections** | Browser `localStorage` | Per browser |
| **Request history (14 days)** | Browser `IndexedDB`, auto-pruned | Per browser |
| **Open tabs** | Browser `localStorage` | Per browser |
| **Legacy disk collections** | `data/collections/*.json` (optional) | Server host |
| **Session** | Signed JWT in an http-only cookie | Per login |

## Notable design choices

- **No secrets in the app for S3**: credentials come from the standard AWS provider
  chain (the host's IAM role in production).
- **Binary-safe**: HTTP and FTP downloads that aren't text are returned base64-encoded
  and flagged, so the UI won't corrupt them.
- **JVM-wide SOCKS**: the bridge is a standard SOCKS5 server, so any client that honors
  `-DsocksProxyHost` (including Apache HttpClient's default socket factory) routes through
  it without code changes.
