# Deploying to a VPS (Rocky Linux / AlmaLinux)

This walks through taking WA Finance Bot from your laptop to a real server
with a public HTTPS URL, running 24/7, with WhatsApp actually connected.
Written for **Rocky Linux 9** or **AlmaLinux 9** (RHEL-family — uses `dnf` and
`firewalld`; on Ubuntu/Debian swap `dnf`→`apt` and `firewalld`→`ufw`).

Time: 45–90 minutes the first time. You'll need SSH access to the VPS as
`root` (or a user with `sudo`), and a phone with WhatsApp for the final test.

**No domain yet?** This guide gets you a real, trusted HTTPS certificate
*without* buying one first, using a free service (`sslip.io`). You can swap in
a real domain later — Phase 6 covers both.

---

## Phase 0 — What you're building

```
Meta WhatsApp Cloud API
        │ webhook (HTTPS, signed)
        ▼
   nginx :443  ──TLS──  Let's Encrypt cert
        │ reverse proxy
        ▼
   Node.js app :3000  (systemd service, auto-restart, auto-start on boot)
        │
        ▼
   PostgreSQL :5433  (Docker container, data on a named volume)
```

Only nginx (80/443) and SSH (22) are ever exposed to the internet. Node and
Postgres only listen on `127.0.0.1` / inside Docker — never reachable directly
from outside.

---

## Phase 1 — First login and basic hardening

SSH in as root (replace with your VPS's real IP):

```bash
ssh root@YOUR_SERVER_IP
```

Update everything and set the timezone (all your cron jobs — the Sunday
summary — assume Asia/Jakarta):

```bash
dnf update -y
timedatectl set-timezone Asia/Jakarta
```

Create a non-root user to work as (never run the app as root):

```bash
adduser deploy
passwd deploy
usermod -aG wheel deploy       # wheel = sudo access on RHEL-family
```

From here on, **log out and back in as `deploy`**, and use `sudo` for
anything that needs root:

```bash
exit
ssh deploy@YOUR_SERVER_IP
```

Confirm the firewall is on and allow only SSH for now (we'll add 80/443 in
Phase 6):

```bash
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
sudo firewall-cmd --list-services      # should show: ssh
```

---

## Phase 2 — Install Node.js 22

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version      # expect v22.x
```

---

## Phase 3 — Install Docker (for PostgreSQL)

Rocky/AlmaLinux ship no Docker package — pull it from Docker's own repo (this
is Docker **Engine**, not Docker Desktop — no GUI, made for servers):

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker deploy
```

Log out and back in (group membership needs a fresh session), then confirm:

```bash
docker run hello-world
```

---

## Phase 4 — Get the code onto the server

Simplest path: push the project to a **private** GitHub repo from your PC,
then clone it on the server. This also makes future updates a one-line `git
pull` (see Phase 12).

On your PC (only if you haven't already):

```bash
cd WA-FINANCE-BOT
git init
git add .
git commit -m "Initial commit"
gh repo create wa-finance-bot --private --source=. --push
```

On the server:

```bash
sudo mkdir -p /opt/wa-finance-bot
sudo chown deploy:deploy /opt/wa-finance-bot
git clone https://github.com/YOUR_USERNAME/wa-finance-bot.git /opt/wa-finance-bot
cd /opt/wa-finance-bot
npm ci --omit=dev
```

No GitHub / prefer not to use git? `scp -r` the folder instead — just skip
`git clone` and copy the project directory (excluding `node_modules`) to
`/opt/wa-finance-bot`, then run `npm ci --omit=dev` there.

---

## Phase 5 — Production environment file

```bash
cd /opt/wa-finance-bot
cp .env.example .env
```

Generate a **fresh** secret on the server — never reuse the one from your
laptop's `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env` (`nano .env`) and set:

```ini
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/wa_finance?schema=public"
APP_JWT_SECRET=<paste the value you just generated>
APP_PUBLIC_URL=https://your-hostname-from-phase-6
ALLOW_AUTO_REGISTER=false
```

Leave the `WA_*` values as placeholders for now — you'll fill those in once
the webhook URL exists (Phase 8). **Set `ALLOW_AUTO_REGISTER=false`** on a
real server: `true` means *any* WhatsApp number that texts the bot gets an
account. Flip it to `true` only if you deliberately want open self-signup;
otherwise, register users yourself first (`INSERT` via `prisma studio`, or a
short admin script) then set it back to `false`.

---

## Phase 6 — A public HTTPS URL

Meta requires a real, valid HTTPS certificate for the webhook — a bare IP or
a self-signed cert will not work.

### Option A — free, works today: `sslip.io`

`sslip.io` is a DNS service that resolves `<your-ip-with-dashes>.sslip.io`
straight to that IP, with zero setup. Let's Encrypt will happily issue a real,
trusted certificate for it.

```bash
# if your server IP is 203.0.113.42:
echo "Your hostname: 203-0-113-42.sslip.io"
```

Use that as your hostname for the rest of this guide.

### Option B — recommended before real users touch this: buy a domain

A `.com`/`.id` domain is ~Rp150,000/year (Namecheap, Niagahoster, etc.).
Once bought, add an **A record** pointing at your VPS IP:

| Type | Name | Value |
|---|---|---|
| A | `keuangan` (→ `keuangan.yourdomain.com`) | `YOUR_SERVER_IP` |

DNS can take a few minutes to a few hours to propagate. Check with:

```bash
dig +short keuangan.yourdomain.com
```

Once it returns your server's IP, use that hostname for the rest of this
guide instead of the `sslip.io` one — everything else is identical. Switching
later (sslip.io → real domain) just means re-running Phase 8's `certbot`
command with the new hostname and updating `APP_PUBLIC_URL` + the Meta webhook
URL.

---

## Phase 7 — Start PostgreSQL and run migrations

```bash
cd /opt/wa-finance-bot
docker compose up -d
docker compose ps                      # should show wa-finance-db, "healthy"
npm run migrate:deploy                 # applies existing migrations, non-interactive
```

`migrate:deploy` (not `migrate:dev`) is the production-safe command — it
never prompts and never generates a new migration file, it only applies the
ones already in `prisma/migrations/`.

---

## Phase 8 — nginx reverse proxy + TLS

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
```

**RHEL-family-specific step** (this trips up everyone coming from an
Ubuntu guide — SELinux blocks nginx from talking to *any* backend port by
default):

```bash
sudo setsebool -P httpd_can_network_connect 1
```

Create the site config — replace `YOUR_HOSTNAME` with your Phase 6 hostname:

```bash
sudo tee /etc/nginx/conf.d/wa-finance-bot.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name YOUR_HOSTNAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

Open the firewall for web traffic:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

Install certbot and issue the certificate (it edits the nginx config above to
add the `443`/TLS block and sets up auto-renewal automatically):

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_HOSTNAME
```

Answer the prompts (email, agree to terms, choose **redirect** HTTP→HTTPS
when asked). Confirm renewal is scheduled — certbot's package installs a
systemd timer automatically:

```bash
sudo systemctl list-timers | grep certbot
```

Now update `.env`: `APP_PUBLIC_URL=https://YOUR_HOSTNAME`.

---

## Phase 9 — Run the app as a systemd service

Don't use `npm run dev` (that's a file-watcher for local editing) or a
terminal you leave open (it dies when you disconnect). A systemd service
restarts on crash and starts automatically on reboot.

```bash
sudo tee /etc/systemd/system/wa-finance-bot.service > /dev/null <<'EOF'
[Unit]
Description=WA Finance Bot
After=network.target docker.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/wa-finance-bot
EnvironmentFile=/opt/wa-finance-bot/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wa-finance-bot
sudo systemctl status wa-finance-bot        # should say "active (running)"
```

Verify end to end:

```bash
curl -s https://YOUR_HOSTNAME/health
# {"ok":true,"uptime":...}
```

If that fails, see the troubleshooting table at the bottom before continuing.

---

## Phase 10 — Connect real WhatsApp

Follow **README.md → "Meta WhatsApp Cloud API setup"** for creating the Meta
app, WhatsApp product, and permanent access token — steps 1–4 are identical
whether local or deployed. Then, instead of an ngrok tunnel:

1. Put the real `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_ACCESS_TOKEN`,
   `WA_PHONE_NUMBER_ID` into `/opt/wa-finance-bot/.env`.
2. Restart the service so it picks up the new values:
   ```bash
   sudo systemctl restart wa-finance-bot
   ```
3. In the Meta App Dashboard → WhatsApp → Configuration → Webhook, set the
   callback URL to `https://YOUR_HOSTNAME/webhook` and the verify token to
   match `WA_VERIFY_TOKEN`. Subscribe to the **messages** field.
4. From your own phone, message the test number: `makan siang 50rb`. You
   should get the confirmation reply within a couple of seconds.
5. Register the `weekly_summary` template (README.md has the exact body to
   paste into WhatsApp Manager → Message templates).

Open `https://YOUR_HOSTNAME` on your phone, send **login** to the bot, and
sign into the dashboard — then "Add to Home screen" for the installed-app
feel.

---

## Phase 11 — Confirm the firewall is locked down

```bash
sudo firewall-cmd --list-services
# expect: ssh http https  — nothing else
```

Node (`:3000`) and Postgres (`:5433`) should NOT be reachable from outside —
they're bound to `127.0.0.1` / Docker's internal network, and nginx is the
only public door. Confirm from your own laptop (should hang/refuse, not
connect):

```bash
curl -m 5 http://YOUR_SERVER_IP:3000/health   # should fail/timeout
```

---

## Phase 12 — Backups

A nightly dump, kept for 14 days, is enough for a personal-scale app:

```bash
sudo mkdir -p /opt/backups
sudo tee /opt/backup-db.sh > /dev/null <<'EOF'
#!/bin/bash
set -e
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec wa-finance-db pg_dump -U postgres wa_finance | gzip > /opt/backups/wa_finance-$STAMP.sql.gz
find /opt/backups -name "*.sql.gz" -mtime +14 -delete
EOF
sudo chmod +x /opt/backup-db.sh

# run it once now to confirm it works
sudo /opt/backup-db.sh
ls -la /opt/backups
```

Schedule it (`sudo crontab -e`):

```cron
0 3 * * * /opt/backup-db.sh
```

For real peace of mind, periodically copy `/opt/backups` somewhere off this
server (e.g. `rclone` to cloud storage, or a plain `scp` to your laptop) — a
backup that lives only on the machine it's backing up doesn't survive that
machine dying.

---

## Phase 13 — Updating the app later

```bash
cd /opt/wa-finance-bot
git pull
npm ci --omit=dev
npm run migrate:deploy
sudo systemctl restart wa-finance-bot
```

Watch logs live while you test:

```bash
sudo journalctl -u wa-finance-bot -f
```

If you change anything in `public/` (the dashboard), also bump the cache name
in `public/sw.js` (`const CACHE = 'keuangan-shell-v1'` → `v2`) — otherwise
phones with the PWA already installed keep serving the old cached version.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl /health` → connection refused | Service not running | `sudo systemctl status wa-finance-bot`, check `journalctl -u wa-finance-bot` |
| nginx → 502 Bad Gateway | Node crashed, or SELinux blocking the proxy | `journalctl -u wa-finance-bot`; also re-run `setsebool -P httpd_can_network_connect 1` |
| Webhook returns 401 from Meta | `WA_APP_SECRET` doesn't match the Meta App Dashboard value | Re-copy App settings → Basic → App secret exactly, restart the service |
| `certbot` fails to issue | Port 80 not reachable from the internet yet | Confirm `firewall-cmd --list-services` includes `http`, and DNS/sslip.io hostname resolves to this server |
| Certificate expired | Renewal timer not running | `systemctl list-timers \| grep certbot`; renew manually with `sudo certbot renew` |
| `docker compose up` fails | Docker service not running, or user not in `docker` group | `sudo systemctl status docker`; re-login after `usermod -aG docker` |
| Migration fails: "can't reach database" | Postgres container not up yet | `docker compose up -d`, wait a few seconds, retry |
| Dashboard login says "kode tidak ditemukan" | Code expired (5 min) or already used | Send `login` to the bot again for a fresh code |
| Weekly summary never arrives | Template not approved yet, or user never opted in | Check WhatsApp Manager → Message templates status; user must not have sent `stop` |
