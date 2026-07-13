# Auth & Secrets — VPS Deployment

Captured during 009 execution. Reference this when rotating secrets, adding a teammate, rebuilding the droplet, or debugging an auth failure.

## Access to the droplet

**Mechanism:** SSH key auth only. Password auth disabled (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

**Root SSH:** enabled but key-only (`PermitRootLogin prohibit-password`, Ubuntu default). Deviation from 009 for smoke-test simplicity — non-root `deploy` user skipped. Revisit at productization.

**Interactive SSH key (Franklin ↔ droplet):** `vim-dojo` (ED25519), pre-registered on the DO account.
- Private key: `~/.ssh/vim-dojo` on Franklin's laptop
- Public key: registered in DO, injected to `/root/.ssh/authorized_keys` at droplet creation time
- Fingerprint (MD5): `52:6f:1a:06:73:eb:94:04:1c:62:43:15:fe:98:e6:4b`
- Connect: `ssh -i ~/.ssh/vim-dojo root@<droplet-ip>`

**Deploy SSH key (GH Actions → droplet):** *reuses `vim-dojo`.* Deviation from 009 §9 (which spec'd a separate deploy-only key). Rationale: vim-dojo already in `/root/.ssh/authorized_keys`, no new setup. Trade-off accepted — if GH Secrets ever leak, vim-dojo is compromised broadly (rotate by generating fresh key, re-adding to DO + all boxes, updating GH secret). For a smoke test, acceptable.

GitHub Actions secrets:
- `SSH_HOST` = droplet IPv4
- `SSH_USER` = `root`
- `SSH_PRIVATE_KEY` = contents of `~/.ssh/vim-dojo` (private key)

## Secrets on the box

**File:** `/etc/companion-bot.env` — owner root, mode 600, read/write by root only. Sourced by systemd via `EnvironmentFile=` in the unit file (step 6).

Retrieve values from the box:
```bash
cat /etc/companion-bot.env
```

Fields:
- `NODE_ENV=production`
- `DATABASE_URL=postgres://postgres:pillowchat@127.0.0.1:5432/postgres` — see Postgres section
- `SESSION_SECRET` — 32-byte hex, generated with `openssl rand -hex 32` at env-file creation. Value lives only in `/etc/companion-bot.env` (and Franklin's terminal scrollback from that moment). **Never commit or copy this value to the repo.**
- `OPENROUTER_API_KEY` — placeholder `REPLACE_ME` at write time. Franklin edits the file to paste the real key before the systemd unit starts.
- `RATE_LIMIT_PER_SESSION=50`
- `RATE_LIMIT_PER_IP_HOURLY=200`

## Postgres

- Container: `pillow-pg` (image `postgres:16`), `--restart unless-stopped`
- Port bind: `127.0.0.1:5432:5432` — loopback only; ufw additionally blocks 5432 from anywhere else
- Superuser: `postgres` (default) / password `pillowchat` (static, hardcoded)
- Data volume: docker named volume `pillow-pg-data` — persists across `docker restart` and `docker rm && docker run`

**Why a static password is fine here:** the security controls that actually matter are (1) the loopback-only port bind and (2) ufw firewall rules. The password is a formality Postgres requires; it doesn't gate reachability. Smoke-test tradeoff — upgrade to a generated hex at productization.

**Access from the box:**
```bash
docker exec -it pillow-pg psql -U postgres              # interactive shell
docker exec pillow-pg psql -U postgres -c '\dt'         # list tables
docker exec pillow-pg psql -U postgres -c 'SELECT count(*) FROM messages'
```

## SSH host key trust

First-connection ED25519 fingerprint accepted manually on Franklin's laptop → stored in `~/.ssh/known_hosts`. If the droplet is ever rebuilt (new host key on same IP), clear the stale entry before reconnecting:
```bash
ssh-keygen -R <droplet-ip>
```

## Recovery paths

- **Lost SSH key access:** DO dashboard → droplet → Access → **Reset Root Password** → email delivers temp password → Access → **Launch Droplet Console** → login as root → re-add your public key to `/root/.ssh/authorized_keys`. Note: DO's web console has unreliable paste — expect friction.
- **Lost Postgres password:** it's `pillowchat`. If you've also lost SSH, follow the row above first.
- **Lost SESSION_SECRET:** invalidates all existing sessions when regenerated (users get logged out; on this app they'd start fresh chats). Steps: SSH in → edit `/etc/companion-bot.env` → replace SESSION_SECRET with `openssl rand -hex 32` → `systemctl restart companion-bot`.
- **Suspected compromise:** rotate everything. Regenerate SESSION_SECRET, change Postgres password (rewrite `DATABASE_URL` and `POSTGRES_PASSWORD` env, restart container + service), revoke and re-add SSH keys on DO, rotate `OPENROUTER_API_KEY` on OpenRouter.

## Deviations from 009 recorded here

1. **No `deploy` user** — root SSH + process ownership. Root cause: 009's `--disabled-password` + immediate root-SSH-disable created a chicken-egg lockout during our first attempt. Smoke-test threat model doesn't justify user separation.
2. **Postgres password is static `pillowchat`** rather than `openssl rand -hex 24`. Loopback + ufw is the actual security control.
3. **No `/etc/sudoers.d/deploy-restart`** — not needed since GH Actions SSHes as root.

## Explicitly out of scope for M2

- Secrets management (Doppler / SOPS / Vault)
- Rotating SESSION_SECRET on a schedule
- Postgres backup / snapshot automation
- SSH session audit logging
