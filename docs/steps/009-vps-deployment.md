# 009 — VPS Deployment (Public Smoke Test Ship)

## Context

Last M2 ship-blocker. Everything else (DB, session, persistence, rate limits, client error handling, gate mechanics) is landed on `main` after 004-008. This step gets the app onto a public URL so strangers can actually reach it and the demand-signal data starts flowing.

Design doc §2 committed to DigitalOcean; this step is the "how" for that decision. `/api/health` and uptime monitoring were deferred (see 003 §Out), so scope here is intentionally narrow: provision, install, wire DNS + TLS, ship, verify.

**Prereqs from earlier decisions (already confirmed):**
- Provider: DigitalOcean, $12/mo droplet (2 GB / 1 vCPU / 50 GB SSD), Ubuntu 24.04 LTS
- Domain: Squarespace-registered (name TBD by Franklin), managed as standard registrar (A record → droplet IP)
- Postgres: Docker container on the box, bound to `127.0.0.1:5432`
- Deploy: GitHub Actions with SSH deploy after the first manual push

## Scope

**In:**
- Droplet provisioning + base hardening (non-root user, disable root SSH, ufw)
- Docker + Postgres 16 on the box
- Node 22 LTS + pnpm + the app cloned to `/srv/companion-bot`
- systemd unit for the Node process, secrets in `/etc/companion-bot.env`
- Nginx reverse proxy + Let's Encrypt TLS (`certbot --nginx`)
- DNS A record on Squarespace
- GitHub Actions workflow that ssh's into the box and runs the deploy sequence
- `docs/ops/vps-setup.md` — reproducible runbook capturing the manual first-push steps

**Out (deferred):**
- `/api/health` and uptime monitoring — see 003 §Out
- Log aggregation — `journalctl -u companion-bot` is enough for M2
- Postgres backups — 004 §Notes explicitly out for M2; reintroduce with encryption at M6+
- Staging environment — single prod box for smoke test; separate `staging.<domain>` is post-productization
- Cloudflare / CDN / DDoS layer — direct A record for M2; add if abuse patterns show up
- Zero-downtime deploys — `systemctl restart` drops connections mid-stream. Fine at M2 (deploys are infrequent, users retry). Blue/green is post-productization

## Approach

Ordered so each step is verifiable before the next.

### 1. Droplet provisioning

- DO dashboard → Create Droplet → Ubuntu 24.04 LTS x64, $12/mo Regular (2 GB / 1 vCPU / 50 GB SSD)
- Region: NYC3 (US-East default; matches likely target audience for Squarespace-registered domain)
- Authentication: SSH key (paste local `~/.ssh/id_ed25519.pub`, not password)
- Hostname: `companion-bot-01`
- Note the public IPv4 address — used in DNS + GitHub Actions secret

### 2. Base hardening

Ssh in as root once:

```bash
ssh root@<droplet-ip>

# non-root deploy user with sudo
adduser --disabled-password --gecos '' deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# disable root SSH + password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

Verify: `ssh deploy@<droplet-ip>` works, `ssh root@<droplet-ip>` refuses. All further work as `deploy`.

### 3. Install runtime deps

```bash
# system deps
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx certbot python3-certbot-nginx

# Docker (official convenience script — Ubuntu apt version lags)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
# log out + back in for group to take effect

# Node 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

Verify: `node -v` = v22.x, `pnpm -v` prints, `docker ps` works without sudo.

### 4. Postgres via Docker

Same command as 004 §1, but bound to loopback only:

```bash
docker run -d --name pillow-pg \
  --restart unless-stopped \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=<generate: openssl rand -hex 24> \
  -v pillow-pg-data:/var/lib/postgresql/data \
  postgres:16
```

Note the password — goes into `/etc/companion-bot.env` next. `127.0.0.1:` prefix means only local processes can reach it (ufw is belt-and-suspenders here).

Verify: `docker ps` shows healthy, `docker exec -it pillow-pg psql -U postgres -c '\l'` lists dbs.

### 5. App code + secrets

```bash
sudo mkdir -p /srv/companion-bot
sudo chown deploy:deploy /srv/companion-bot
cd /srv/companion-bot
git clone https://github.com/<your-gh-org>/sexting.git .
pnpm install --frozen-lockfile
pnpm build
```

Create `/etc/companion-bot.env` as root (chmod 640, deploy group):

```
NODE_ENV=production
DATABASE_URL=postgres://postgres:<pg-password-from-step-4>@127.0.0.1:5432/postgres
SESSION_SECRET=<generate: openssl rand -hex 32>
OPENROUTER_API_KEY=<real key>
RATE_LIMIT_PER_SESSION=50
RATE_LIMIT_PER_IP_HOURLY=200
```

```bash
sudo chown root:deploy /etc/companion-bot.env
sudo chmod 640 /etc/companion-bot.env
```

Run migrations once from CLI:

```bash
cd /srv/companion-bot
set -a && source /etc/companion-bot.env && set +a
pnpm db:migrate
```

Verify: `docker exec -it pillow-pg psql -U postgres -c '\dt'` shows the four tables from 004.

### 6. systemd unit

Create `/etc/systemd/system/companion-bot.service`:

```ini
[Unit]
Description=Companion Bot (TanStack Start / Nitro)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/srv/companion-bot
EnvironmentFile=/etc/companion-bot.env
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now companion-bot
sudo systemctl status companion-bot   # expect active (running)
sudo journalctl -u companion-bot -n 50   # sanity-check logs
```

Verify: `curl -s http://127.0.0.1:3000/ | head -20` returns landing page HTML.

### 7. DNS

Squarespace domain panel → DNS Settings for the target domain:
- **A record**: `@` → `<droplet-ip>`, TTL 1 hour
- **A record**: `www` → `<droplet-ip>`, TTL 1 hour (or CNAME `www` → `@`)

Verify: `dig +short <domain>` returns droplet IP (may take 5-60 min to propagate).

### 8. Nginx + TLS

Create `/etc/nginx/sites-available/companion-bot`:

```nginx
server {
  listen 80;
  server_name <domain> www.<domain>;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # SSE / streaming
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/companion-bot /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# TLS — certbot edits the nginx config in-place and installs the renewal timer
sudo certbot --nginx -d <domain> -d www.<domain> --redirect --agree-tos -m <email>
sudo systemctl status certbot.timer   # expect active
```

Verify: `curl -sI https://<domain>` returns `200` with `Strict-Transport-Security` header. Browser hits landing page over HTTPS.

**Critical:** `proxy_buffering off` is what makes SSE actually stream. Without it, Nginx buffers the response and the client waits for the whole reply to complete before seeing any tokens — kills the streaming UX silently.

### 9. GitHub Actions deploy

Generate a deploy-only SSH key on your laptop (not the personal one):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/companion-bot-deploy -C 'gh-actions-deploy' -N ''
# copy the .pub key content, ssh into the droplet as deploy, append to ~/.ssh/authorized_keys
```

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
- `SSH_HOST` — droplet IP (or domain, once DNS is live)
- `SSH_USER` — `deploy`
- `SSH_PRIVATE_KEY` — contents of `~/.ssh/companion-bot-deploy` (the private key)

Grant the `deploy` user passwordless sudo for just the restart command. Edit `/etc/sudoers.d/deploy-restart` as root (via `visudo -f /etc/sudoers.d/deploy-restart`):

```
deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart companion-bot
```

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            set -euo pipefail
            cd /srv/companion-bot
            git fetch origin main
            git reset --hard origin/main
            pnpm install --frozen-lockfile
            pnpm build
            set -a && source /etc/companion-bot.env && set +a
            pnpm db:migrate
            sudo systemctl restart companion-bot
```

Verify: push a whitespace commit to `main`, watch the Actions tab, then `curl https://<domain>/` on the new build.

### 10. Ops runbook

Write `docs/ops/vps-setup.md` capturing the concrete values used (droplet ID, region, hostname), the sequence above with the actual domain filled in, and these day-2 operations:

- Rollback: `git reset --hard <sha> && pnpm build && sudo systemctl restart companion-bot` on the box
- Rate-limit escape hatch: edit `/etc/companion-bot.env`, set `RATE_LIMIT_PER_IP_HOURLY=0`, `sudo systemctl restart companion-bot` (per 003 §Notes)
- Peek at demand-signal data: `docker exec -it pillow-pg psql -U postgres` then queries from 003 §Notes
- Logs: `sudo journalctl -u companion-bot -f`
- Restart Postgres: `docker restart pillow-pg` (volume-backed, data survives)
- Certbot renewal check: `sudo certbot renew --dry-run`

## Files touched

**New:**
- `.github/workflows/deploy.yml`
- `docs/ops/vps-setup.md`

**On the VPS (not in the repo):**
- `/etc/companion-bot.env`
- `/etc/systemd/system/companion-bot.service`
- `/etc/nginx/sites-available/companion-bot` (+ symlink in `sites-enabled/`)
- `/etc/sudoers.d/deploy-restart`

**No repo code changes** — the app is deploy-ready as-is from 004-008.

## Verification

End-to-end, hitting the public URL from a fresh browser:

1. **DNS + TLS:** `curl -sI https://<domain>` returns `200`, `Strict-Transport-Security` present, TLS cert issued by Let's Encrypt.
2. **Landing page:** browser at `https://<domain>` renders the landing page. Click through the 18+ gate, land on `/chat`.
3. **SSE streaming works through Nginx:** send a message, tokens appear progressively (not all at once). This is the `proxy_buffering off` check.
4. **Persistence:** ssh into the droplet, `docker exec -it pillow-pg psql -U postgres -c 'SELECT count(*) FROM messages'` shows rows accumulating.
5. **Rate limits fire in prod:** `for i in $(seq 1 51); do curl -X POST https://<domain>/api/chat -H 'Content-Type: application/json' -b /tmp/c -c /tmp/c -d '{"messages":[{"role":"user","content":"hi"}]}'; done` — the 51st returns 429 with the session-limit JSON.
6. **`x-forwarded-for` reaches the app:** the `ip_hash` in `sessions` rows is not `sha256('local')` — it's derived from a real client IP.
7. **Restart survives:** `sudo systemctl restart companion-bot`, wait 5s, browser refresh works. Postgres data persists across restart.
8. **GitHub Actions deploy:** push a trivial commit, watch the Actions run go green, verify the change is live.
9. **Cost sanity:** OpenRouter dashboard after ~20 min of self-testing shows spend under $1.
10. **journalctl clean:** `sudo journalctl -u companion-bot -n 200` shows no unexpected errors during normal chat flow.

## Notes / deferred concerns

- **`git pull` in Actions vs. artifact upload.** Current design pulls source on the box and builds there. Simpler; no artifact registry needed. Downside: builds compete with runtime for the droplet's 2 GB RAM — `pnpm build` briefly spikes. If this bites, switch to building in Actions and rsyncing `.output/` up.
- **Deploy restarts drop SSE mid-stream.** Users chatting during a deploy see a "Couldn't send" bubble; 008's retry handles it. Fine at M2 iteration cadence. Zero-downtime is post-productization (blue/green with two systemd units + Nginx upstream switch).
- **Secrets in `/etc/companion-bot.env` are unrotated.** Manual edit + restart is the rotation flow. Doppler / SOPS / Vault only make sense once multiple people deploy.
- **No staging.** Small changes deploy straight to prod. Kept honest by keeping deploys small and reversible (rollback via `git reset --hard`).
- **`pnpm install` uses network on every deploy.** Cheap and consistent. Only becomes friction if pnpm registry has an outage during a hot fix — fall back to a manual local build + rsync.
- **Nginx `proxy_read_timeout 3600s`.** Long enough to cover any reasonable SSE reply. Tuned down post-launch once we see actual assistant-response durations.
- **`RATE_LIMIT_PER_IP_HOURLY=0` really is the abuse kill switch.** Documented in the ops runbook and 003 §Notes. Zero-config panic button.
- **NodeSource setup script** pulls Node into `/usr/bin/node` (not a version manager path). systemd unit hardcodes that path — if we later switch to `nvm`/`n`, update `ExecStart=`.
- **What if the droplet dies?** DO's snapshot feature ($1.20/mo per snapshot) is the M2 disaster-recovery story. Take one manually right after step 8 lands and works. Automated snapshots are $$/mo — post-productization.
