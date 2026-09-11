# Go-live guide

How to run the portal on a real server with your own domain and HTTPS. The steps assume an Ubuntu 22.04/24.04 VPS
(2 GB RAM is plenty to start). A Windows Server note is at the end.

## 1. Before you start

- A domain (e.g. `portal.yourschool.in`) with an **A record** pointing at the server's IP.
- Optional: Razorpay **live** keys (Dashboard → Settings → API keys) and SMTP details (e.g. Zoho, Google Workspace, Amazon SES).
- Privacy policy and terms pages on your website. You collect Aadhaar and ID documents and take payments, so India's DPDP Act 2023 and Razorpay both expect them.

## 2. Install the software

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs mysql-server nginx certbot python3-certbot-nginx
sudo mysql_secure_installation
```

## 3. Create the database and a dedicated user

Don't let the app use MySQL `root`. Pick a strong password of your own:

```bash
sudo mysql
```
```sql
CREATE DATABASE rpto_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'rpto'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON rpto_portal.* TO 'rpto'@'localhost';
EXIT;
```

## 4. Install the app

```bash
sudo mkdir -p /srv/rpto && sudo chown $USER /srv/rpto
# copy the project here (git clone, or scp/WinSCP the folder without node_modules and uploads)
cd /srv/rpto
npm ci --omit=dev
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # paste as SESSION_SECRET
nano .env
```

Production `.env` values to set:

| Setting | Value |
|---|---|
| `APP_URL` | `https://portal.yourschool.in` (needed for emailed links) |
| `SESSION_SECRET` | the random string from above |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `rpto` / your password / `rpto_portal` |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | your admin login; change the password after first login |
| `SMTP_*`, `MAIL_FROM` | your mail provider, or leave empty |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | live keys, or leave empty |
| `CREDIT_PRICE`, `PARTNER_SHARE_PERCENT`, `PRO_PRICE_*`, `FREE_FLIGHT_LIMIT` | your pricing (`0` turns credits / partner share off) |

Then create the tables and the super admin. **Do not use `--demo` on a live server.**

```bash
npm run setup
```

## 5. Keep it running (PM2)

```bash
sudo npm install -g pm2
pm2 start src/server.js --name rpto --node-args="--env-file=.env"
pm2 save
pm2 startup     # run the command it prints, so the app starts after a reboot
pm2 logs rpto   # view logs
```

## 6. Nginx + HTTPS

`/etc/nginx/sites-available/rpto`:

```nginx
server {
  server_name portal.yourschool.in;
  client_max_body_size 80m;          # flight logs can be large
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # lets the app mark cookies Secure
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rpto /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d portal.yourschool.in     # free HTTPS certificate, auto-renews
```

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Never open port 3306 (MySQL) or 3000 (the app) to the internet. Nginx is the only way in.

## 8. Backups (daily)

The database and the `uploads/` folder (documents, logos, flight logs) are everything you need to restore.

```bash
sudo mkdir -p /var/backups/rpto
crontab -e
```
```cron
30 2 * * * mysqldump --single-transaction -u rpto -p'your-db-password' rpto_portal | gzip > /var/backups/rpto/db-$(date +\%F).sql.gz
45 2 * * * tar czf /var/backups/rpto/uploads-$(date +\%F).tgz -C /srv/rpto uploads
0 3 * * * find /var/backups/rpto -mtime +30 -delete
```

Copy the backups off the server as well (e.g. `rclone` to Google Drive or S3), and do a test restore once.

## 9. Updating the app

```bash
cd /srv/rpto
# copy in the new code
npm ci --omit=dev
npm run setup        # creates any new tables; safe to re-run
pm2 restart rpto
```

`npm run setup` creates new tables but does **not** add new columns to existing tables. If a release changes an existing
table, apply the `ALTER TABLE` statements from its notes before restarting.

> **This release changed many existing tables** (per-trainee sessions, fees & receipts, incidents, tracks, users, …). If you installed an
> earlier test build, drop that database and run `npm run setup` again rather than upgrading it — there is no migration from the pre-release schema.

## 10. Go-live checklist

- [ ] HTTPS works and `http://` redirects to `https://` (certbot sets this up).
- [ ] Logged in as super admin, changed the password and turned on **two-step verification** under **My account**.
- [ ] No demo data (`@demo.test` users) exists.
- [ ] **Forgot password** emails arrive (needs SMTP and `APP_URL`).
- [ ] Razorpay: one small real payment for Pilot Pro and one for credits succeeds, then refund them from the Razorpay dashboard.
- [ ] `https://your-domain/uploads/...` returns 404. Documents are only served through the login-checked `/files/` route.
- [ ] **Training defaults** (syllabus + question bank) match your approved training manual — replace the starter questions.
- [ ] A native speaker has checked the simulator's voice-coaching phrases (`PHR` / `PHR2` in `public/sim.js`).
- [ ] Tutorials added under **Tutorials** (super admin), or the demo ones removed.
- [ ] Privacy policy states what you collect (Aadhaar, ID, medical, photos), why, who can see it and how long you keep it.
- [ ] Daily backups run, and a copy exists off the server.

## Windows Server instead

Install Node.js 22 and MySQL, then run the app as a service with [NSSM](https://nssm.cc)
(`nssm install rpto "C:\Program Files\nodejs\node.exe" "--env-file=.env src\server.js"`, with the startup directory set to the app folder).
Put IIS (URL Rewrite + ARR) or Caddy in front for HTTPS, allow uploads up to 80 MB there, and back up with `mysqldump` plus a copy of `uploads\` from Task Scheduler.
