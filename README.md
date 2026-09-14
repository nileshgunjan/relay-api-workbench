# Relay — a client/server Postman clone

A Postman-like API workbench where **the request runs on the server**, not in the
browser. You deploy the server onto your whitelisted AWS host; developers open the
UI from anywhere. The server's IP is the one the target APIs / FTP / web services
see, so individual developer IPs never need to be whitelisted.

```
Browser (any dev, anywhere)
        │  HTTPS  (gated by static username/password)
        ▼
Relay server  ── runs on your whitelisted AWS box ──▶ target APIs / SOAP / FTP / SFTP
        │
        └─ collections persisted as JSON files on disk
```

## Documentation

- [`docs/TECH_STACK.md`](docs/TECH_STACK.md) — technologies used, module layout, data/persistence model.
- [`docs/FEATURES.md`](docs/FEATURES.md) — full feature list (protocols, collections, tabs, import, SOCKS bridge).
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — where/how to deploy, host specs, ports, env vars, security checklist.

## Features

- **REST**: methods, query params, headers, Bearer/Basic/API-key auth, JSON/raw/form bodies, response viewer with timing + size + pretty JSON.
- **SOAP / web services**: XML body mode with a `SOAPAction` helper (it's HTTP under the hood, so all header/auth options apply).
- **FTP / FTPS / SFTP**: list a directory, download a file (previewed if textual), or upload text content.
- **Two collection scopes**:
  - **Flx (shared)** — read-only, loaded by the server from an S3 bucket/prefix and shown to every user. Edit them by updating the files in S3, then hit ⟳ to refresh.
  - **Personal** — private to each person's **browser** (localStorage). Create/rename/delete, save requests, import/export. Nothing personal is stored on the server.
- **History (14 days)** — every Send/Run is recorded per-browser (IndexedDB) with its response, auto-pruned after 14 days. Click an entry to reopen it in a tab.
- **Tabs** — multiple open requests, Postman-style: new (＋), close (×), switch; unsaved tabs show a dot. Open tabs are remembered across reloads.
- **Postman import**: the Import button also accepts a native **Postman Collection v2.0 / v2.1** export. On import it's auto-detected and translated — URLs split into base + query params, headers (with disabled state), `raw`/`urlencoded`/`formdata` bodies, `bearer`/`basic`/`apikey` auth, nested folders flattened into prefixed request names, and collection variables (`{{var}}`) substituted. SOAP requests (by `SOAPAction`/envelope) are detected and set to SOAP mode. Unsupported auth (OAuth, AWS, digest) falls back to no-auth with any auth headers preserved; multipart file fields are dropped.
- **Auth gate**: one static username/password (from env). Session is a signed, http-only cookie.

## Quick start (local, Node ≥ 20)

```bash
cp .env.example .env          # then edit AUTH_* and JWT_SECRET
npm install
npm start
# open http://localhost:8080
```

## Run with Docker (recommended for AWS)

```bash
cp .env.example .env          # edit credentials + JWT_SECRET
docker compose up -d --build
# open http://<host>:8080
```

Collections live in `./data` on the host (bind-mounted), so they survive
`docker compose up --build` and container restarts. Back up that folder.

## Configuration (env vars)

| Variable              | Default            | Purpose                                              |
|-----------------------|--------------------|------------------------------------------------------|
| `AUTH_USERNAME`       | `admin`            | Static login username.                               |
| `AUTH_PASSWORD`       | `change-me-please` | Static login password. **Change this.**              |
| `JWT_SECRET`          | *(insecure)*       | Signs the session cookie. **Set a long random one.** |
| `SESSION_TTL_SECONDS` | `43200` (12h)      | How long a login lasts.                              |
| `PORT`                | `8080`             | Server port.                                         |
| `DATA_DIR`            | `./data`           | Where collection JSON files are written.             |
| `MAX_BODY_MB`         | `50`               | Cap on request/response/file size handled.           |
| `REQUEST_TIMEOUT_MS`  | `60000`            | Per-request timeout for the executor.                |
| `SECURE_COOKIE`       | `false`            | Set `true` when served over HTTPS.                   |
| `FLX_S3_BUCKET`       | *(empty)*          | S3 bucket holding shared Flx collections. Blank = Flx disabled. |
| `FLX_S3_PREFIX`       | *(empty)*          | Key prefix to list under (e.g. `collections/`).      |
| `FLX_S3_REGION`       | `us-east-1`        | Bucket region.                                       |
| `FLX_CACHE_TTL_SECONDS` | `300`            | How long the server caches the S3 listing.           |

### Flx / S3 setup

Put your API collection JSONs (Relay exports **or** raw Postman v2.x exports — both are auto-detected and converted) in an S3 bucket, then point the server at it:

```
FLX_S3_BUCKET=my-team-bucket
FLX_S3_PREFIX=relay/collections/
FLX_S3_REGION=us-east-1
```

On the whitelisted AWS host, give the instance/task IAM role `s3:ListBucket` on the bucket and `s3:GetObject` on the prefix — no keys go in the app. Everyone then sees those collections under **Flx (shared)**, read-only. The ⟳ button re-pulls from S3 on demand.

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Deploying behind the whitelisted IP

1. Put this on the AWS host whose outbound IP is whitelisted by your API/FTP/SOAP partners.
2. Set real `AUTH_*` and `JWT_SECRET` values.
3. Front it with your load balancer / reverse proxy and TLS, then set `SECURE_COOKIE=true`.
4. Because every executed request originates from this host, no developer needs their
   own IP whitelisted — they just need the login.

## Routing a local integration job through the whitelisted host (SOCKS5 proxy)

Beyond the interactive UI, Relay can act as a **network bridge** so you can run a
real integration process on your laptop (e.g. `WooCommerceGetOrders` from IntelliJ)
while its traffic exits from this whitelisted host — no per-developer IP whitelisting.

It's a standard **SOCKS5 proxy** built into the server. Java routes *all* TCP through
SOCKS, so REST/HTTPS, SFTP, and passive FTP/FTPS all egress from this box, and vendor
hostnames resolve here too (remote DNS).

**1. Enable it on the host** (in `.env`, then restart):

```
SOCKS_ENABLED=true
SOCKS_PORT=1080
SOCKS_USERNAME=devproxy
SOCKS_PASSWORD=a-strong-secret
# Optional allowlist: exact IPs and/or CIDR ranges. Leave blank if the network
# (security group / VPN) already restricts who can reach the port.
SOCKS_ALLOW_IPS=
```

**If the host is only reachable over your corporate VPN** (the common case), the VPN
*is* the gate — you don't need per-developer IP rules:

- In the security group, allow port `1080` from the **VPN's CIDR** (e.g. `10.8.0.0/16`),
  not individual public IPs.
- Leave `SOCKS_ALLOW_IPS` blank, or set it to that same CIDR for a second layer.
- The SOCKS username/password still gates actual use.

On startup you'll see `SOCKS5 proxy listening on 0.0.0.0:1080 (username/password auth required)`.

**2. Point IntelliJ at it** — Run/Debug Configuration → **VM options**:

```
-DsocksProxyHost=your-aws-host -DsocksProxyPort=1080
-Djava.net.socks.username=devproxy -Djava.net.socks.password=a-strong-secret
```

Run your job as normal. Its outbound calls now originate from the AWS host's IP.

**Validate the tunnel first** with `tools/ConnectivityCheck.java` — a standalone,
JDK-only class. Run it from IntelliJ with the same VM options; it prints your direct
egress IP vs. the proxied one (should become the AWS host's IP), checks your DB
connects through the tunnel, and probes vendor host:port reachability. See the header
comment in that file for exact args.

Notes for dmx-core:
- `-DsocksProxyHost` is JVM-wide and covers Apache HttpClient's default socket factory, JDBC-less HTTP, SFTP (JSch/ssh2), and FTP.
- Use **passive** FTP/FTPS (active-mode data channels don't traverse a proxy).
- To confirm the egress IP from within the job, hit e.g. `https://api.ipify.org` — it should return the AWS host's IP.

## Security notes

- This is a **static single-credential** gate, as requested. It is a shared secret,
  not per-user identity. Anyone with the login can drive requests from your
  whitelisted IP, so keep the deployment on a private network / VPN or behind SSO at
  the proxy layer if the environment is sensitive.
- The server is effectively an authenticated forward proxy. Restrict who can reach it.
- Credentials you type into Auth / FTP fields are sent to the server to execute the
  request and are saved in the collection JSON if you save the request. Treat the
  `data/` folder as sensitive.

## API surface (for reference)

| Method | Path                                        | Purpose                        |
|--------|---------------------------------------------|--------------------------------|
| POST   | `/api/login` · `/api/logout` · `/api/me`    | Auth.                          |
| POST   | `/api/execute`                              | Run an HTTP/HTTPS/SOAP request.|
| POST   | `/api/ftp`                                  | Run an FTP/FTPS/SFTP op.       |
| GET/POST | `/api/collections`                        | List / create collections.     |
| GET/PATCH/DELETE | `/api/collections/:id`            | Read / rename / delete.        |
| POST   | `/api/collections/:id/requests`             | Save (create/update) a request.|
| DELETE | `/api/collections/:id/requests/:requestId`  | Delete a request.              |
| POST   | `/api/collections/import`                   | Import an exported collection. |

## Project layout

```
server/
  index.js              Express app, routes, static serving
  auth.js               Static credentials + signed-cookie sessions
  collections.js        JSON-on-disk CRUD for collections
  executors/
    http.js             REST + SOAP executor (axios)
    ftp.js              FTP / FTPS / SFTP executor
public/
  index.html app.js style.css   The browser UI (no build step)
data/collections/       Persisted collections (git-ignored)
```
