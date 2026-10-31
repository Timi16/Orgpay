# Deploying OrgPay to a server

One Linux server runs everything: Postgres (Docker), the API, the worker and the dashboard (pm2),
behind Caddy for HTTPS. Still Stellar Testnet only: the API refuses to start on any other network.

## 1. Before you buy

- **Server:** 2 vCPU, 4 GB RAM, 40 GB SSD, Ubuntu 24.04 (e.g. Hetzner CX22/CPX21, DigitalOcean or
  Vultr 4 GB, about $6–12 a month). Running: Postgres ≈ 384 MB, API ≈ 150 MB, worker ≈ 120 MB,
  dashboard ≈ 200 MB, Caddy ≈ 30 MB; `next build` peaks around 1.5 GB. 2 GB RAM works only with a
  2 GB swapfile.
- **A domain** (e.g. `useorgpay.xyz`). The dashboard and the API must be on the same registrable
  domain, or the browser drops the session cookie: `app.<domain>` and `api.<domain>`.
- **A Git remote** (e.g. a private GitHub repo) the server can pull from. The repo has none yet:
  `git remote add origin git@github.com:<you>/orgpay.git && git push -u origin main`.
- **Email (optional but recommended):** an SMTP account (Resend, Postmark, Brevo…) for password
  resets and run emails. Without one, resets answer "not set up" and email codes are off.

## 2. DNS

Point three A records at the server's IP: `app`, `api`, and the bare domain (`@`, plus `www` if you
like). If you use Cloudflare, set them to **DNS only** (grey cloud): the API trusts exactly one proxy.

## 3. Prepare the server (once, as root, then as `deploy`)

```sh
adduser --disabled-password deploy && usermod -aG sudo,docker deploy   # after Docker is installed
# SSH: copy your key to /home/deploy/.ssh/authorized_keys, then in /etc/ssh/sshd_config set
#   PasswordAuthentication no  and  PermitRootLogin no ; systemctl restart ssh
apt update && apt -y upgrade && apt -y install ufw fail2ban unattended-upgrades git curl
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

# Docker (for Postgres)
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy

# Node 22 LTS, pnpm and pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs
corepack enable && npm i -g pm2

# Caddy
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy

# 2 GB RAM servers only: add swap
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 4. Get the code and configure it (as `deploy`)

```sh
git clone git@github.com:<you>/orgpay.git ~/orgpay && cd ~/orgpay
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (Secure cookies, no dev mail log) |
| `PORT` / `HOST` | `4400` / `127.0.0.1` |
| `POSTGRES_PASSWORD` | a long random password (`openssl rand -hex 24`) |
| `DATABASE_URL` | `postgresql://orgpay:<that password>@localhost:5438/orgpay` |
| `WEB_ORIGIN` | `https://app.<domain>`, exactly, no trailing slash (must be https in production) |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `HORIZON_URL` / `NETWORK_PASSPHRASE` / `USDC_ISSUER` | keep the Testnet values from `.env.example` |
| `SMTP_URL` / `MAIL_FROM` | your SMTP URL and `OrgPay <no-reply@<domain>>`, or leave `SMTP_URL` empty |
| `EMAIL_VERIFICATION` | `auto` (on when `SMTP_URL` is set); `on` without `SMTP_URL` refuses to start |

Then the dashboard's build-time settings, `apps/web/.env.production`:

```sh
cat > apps/web/.env.production <<'EOF'
NEXT_PUBLIC_API_URL=https://api.<domain>
NEXT_PUBLIC_SITE_URL=https://app.<domain>
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
EOF
```

## 5. First start

```sh
docker compose up -d                          # Postgres on 127.0.0.1:5438
pnpm install --frozen-lockfile
pnpm --filter @orgpay/api db:deploy           # create the tables
pnpm build && pnpm build:web
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup                                   # run the command it prints, so pm2 starts on boot
pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 7

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
echo 'ORGPAY_DOMAIN=<domain>' | sudo tee -a /etc/default/caddy   # or edit {$ORGPAY_DOMAIN} in the file
sudo systemctl restart caddy
```

Check: `curl https://api.<domain>/health` answers `{"status":"ok","db":"up",...}` and
`https://app.<domain>` shows the landing page. Sign up, add a funding wallet and pay a small run.

## 6. Backups and monitoring

```sh
crontab -e
# 15 3 * * * /home/deploy/orgpay/deploy/backup.sh >> /home/deploy/orgpay-backups/backup.log 2>&1
```

Copy `~/orgpay-backups` off the server (rclone to S3/B2 or a Storage Box) and do one test restore
(`deploy/backup.sh` has the command). Point an uptime check (UptimeRobot, Better Stack) at
`https://api.<domain>/health`: it answers 503 when the database is down. Optional: set
`ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` for worker alerts.

## 7. Deploying changes

On the server: `./deploy/deploy.sh <git sha>` pulls, migrates, builds the API and the dashboard,
reloads pm2, checks `/health` and the dashboard for 60 s, and rolls back if either stays down.

From GitHub: `.github/workflows/ci.yml` runs audit, lint, typecheck, tests and both builds on every
push, then deploys `main` over SSH when these are set: secrets `DEPLOY_SSH_KEY` (a key for `deploy`),
`DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), and the variable `DEPLOY_PATH` if the repo isn't at `~/orgpay`.

## Never on the server

- `pnpm seed`: creates `demo@orgpay.local` with a known password.
- `pnpm proof`: writes test runs into the database it points at and needs a Testnet signing key.
- `apps/api/.proof-keys.json`: git-ignored; deploy with `git pull`, never by copying your working folder.
- More than one `orgpay-worker`.
