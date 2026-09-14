# Deployment Guide

## Where to deploy (and why)

Deploy Relay on a host whose **outbound IP is whitelisted** by the APIs / FTP / SOAP
partners you need to reach — i.e. the same AWS environment where your production
integrations run. Every request Relay executes originates from that host, so individual
developer IPs never need whitelisting. Developers only need to reach Relay's web port.

Typical placement:
- An **EC2 instance** or **ECS/Fargate task** in the VPC that already has the whitelisted
  egress (NAT gateway / Elastic IP) and, if you use Flx or DB routing, network reach to
  S3 and the database.
- Fronted by your load balancer / reverse proxy for TLS.

## Host specifications

Relay is lightweight; it's an I/O-bound proxy, not a compute workload.

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| vCPU | 1 | 2 |
| RAM | 512 MB | 1–2 GB (headroom for large responses/files; `MAX_BODY_MB` default 50) |
| Disk | 1 GB | 5 GB (OS + image; plus space for the `data/` volume if used) |
| Node.js | 20 | 20 LTS (or run the Docker image) |
| Network | Outbound to targets from the whitelisted IP | + S3 (Flx) and DB (if routing DB over SOCKS) |

Sizing notes:
- Peak memory scales with concurrent request/response and file sizes. Cap with
  `MAX_BODY_MB` and `REQUEST_TIMEOUT_MS`.
- The SOCKS bridge adds negligible overhead (it streams TCP); memory is per active tunnel.

## Ports

| Port | Purpose | Expose to |
|------|---------|-----------|
| `8080` | Web UI + API (HTTP) | Developers (ideally behind TLS + proxy/VPN) |
| `1080` | SOCKS5 egress bridge (only if `SOCKS_ENABLED=true`) | Developer network / VPN CIDR only |

## Deploy method A — Docker (recommended)

```bash
git clone <your-repo-url> relay-api-workbench
cd relay-api-workbench
cp .env.example .env          # edit credentials + secrets (see table below)
docker compose up -d --build
# UI on http://<host>:8080
```

- Collections written by the legacy disk store persist in `./data` (bind-mounted), so they
  survive rebuilds. Back up that folder if you use it.
- The image is `node:20-alpine`; it installs prod deps only and runs `node server/index.js`.
- A container `HEALTHCHECK` hits `/api/me`.

## Deploy method B — bare Node

```bash
git clone <your-repo-url> relay-api-workbench
cd relay-api-workbench
cp .env.example .env          # edit
npm install --omit=dev
npm start                     # or run under pm2 / systemd
```

Run it under a process manager (systemd, pm2) so it restarts on failure/reboot.

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTH_USERNAME` | `admin` | Static login username. |
| `AUTH_PASSWORD` | `change-me-please` | Static login password. **Change it.** |
| `JWT_SECRET` | *(insecure default)* | Signs the session cookie. **Set a long random value.** |
| `SESSION_TTL_SECONDS` | `43200` (12h) | Login lifetime. |
| `PORT` | `8080` | Web port. |
| `DATA_DIR` | `./data` | Legacy disk collection store. |
| `MAX_BODY_MB` | `50` | Cap on request/response/file size handled. |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request executor timeout. |
| `SECURE_COOKIE` | `false` | Set `true` when served over HTTPS. |
| `FLX_S3_BUCKET` | *(empty)* | S3 bucket for shared Flx collections. Blank = Flx disabled. |
| `FLX_S3_PREFIX` | *(empty)* | Key prefix to list under (e.g. `collections/`). |
| `FLX_S3_REGION` | `us-east-1` | Bucket region. |
| `FLX_CACHE_TTL_SECONDS` | `300` | How long the server caches the S3 listing. |
| `SOCKS_ENABLED` | `false` | Enable the SOCKS5 egress bridge. |
| `SOCKS_PORT` | `1080` | SOCKS listen port. |
| `SOCKS_USERNAME` | *(→AUTH_USERNAME)* | SOCKS auth username. |
| `SOCKS_PASSWORD` | *(→AUTH_PASSWORD)* | SOCKS auth password (required if enabled). |
| `SOCKS_ALLOW_IPS` | *(empty)* | Optional allowlist of source IPs/CIDRs (e.g. a VPN subnet `10.8.0.0/16`). |
| `SOCKS_CONNECT_TIMEOUT_MS` | `20000` | SOCKS upstream connect timeout. |

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Flx / S3 setup

Put collection JSONs (Relay exports **or** raw Postman v2.x exports) in an S3 bucket, then:

```
FLX_S3_BUCKET=my-team-bucket
FLX_S3_PREFIX=relay/collections/
FLX_S3_REGION=us-east-1
```

Grant the host's **IAM role** `s3:ListBucket` on the bucket and `s3:GetObject` on the
prefix — no access keys in the app. Everyone then sees those collections under **Flx**,
read-only; the ⟳ button re-pulls on demand.

## SOCKS bridge setup (routing local jobs through this host)

Enable it and gate it (see `docs/FEATURES.md` and the README for the full walkthrough):

```
SOCKS_ENABLED=true
SOCKS_PORT=1080
SOCKS_USERNAME=devproxy
SOCKS_PASSWORD=<strong-secret>
SOCKS_ALLOW_IPS=            # blank if the security group / VPN already restricts access
```

- If the host is reachable **only over the corporate VPN**, allow port `1080` from the
  **VPN CIDR** in the security group and leave `SOCKS_ALLOW_IPS` blank (or set it to that
  CIDR for defense-in-depth). The layers are: VPN → security group → SOCKS password.
- Developers set two JVM flags in IntelliJ; validate first with
  `tools/ConnectivityCheck.java`.

## TLS / reverse proxy

Terminate TLS at a load balancer (ALB) or reverse proxy (nginx/Caddy) in front of port
8080, then set `SECURE_COOKIE=true`. Do not expose the raw HTTP port publicly.

## Security checklist

- [ ] Changed `AUTH_USERNAME` / `AUTH_PASSWORD` and set a strong `JWT_SECRET`.
- [ ] UI reachable only via private network / VPN / SSO-proxy (it's a shared secret gate).
- [ ] `SECURE_COOKIE=true` behind TLS.
- [ ] SOCKS port firewalled to the VPN/developer CIDR; strong `SOCKS_PASSWORD`.
- [ ] S3 access via IAM role (no keys in the app); bucket is least-privilege.
- [ ] Treat `data/` as sensitive (saved requests can contain credentials).

## Health & operations

- **Health:** `GET /api/me` returns `{ "authenticated": <bool> }` (200) — used by the
  Docker healthcheck and suitable for an ALB target-group check.
- **Logs:** startup prints the HTTP port and, if enabled, the SOCKS listener.
- **Upgrades:** `git pull` → `docker compose up -d --build` (or `npm install --omit=dev &&
  restart`). Personal collections/history live in browsers, so upgrades don't touch them.
- **Backups:** back up the S3 bucket (Flx) and the `data/` volume (if the legacy disk store
  is used).

## Scaling & limits

- Stateless for shared/personal data (Flx is S3-backed; personal/history are per browser),
  so you can run multiple instances behind a load balancer. Use **sticky sessions** or a
  shared `JWT_SECRET` across instances so cookies validate everywhere.
- The legacy disk collection store (`data/`) is node-local; don't rely on it across
  multiple instances.
- Large downloads are held in memory up to `MAX_BODY_MB`; raise host RAM if you increase it.
