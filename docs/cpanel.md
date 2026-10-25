# Hosting Taskly on cPanel

Taskly normally runs on Cloudflare (see [deploy.md](deploy.md)). It can also
run as a Node.js app on cPanel hosting, at an address like
`https://taskly.zawyh.com`, with its data in a SQLite file on that server.

Same app, same features. The differences: one server instead of Cloudflare's
network, scheduled work (reminders, Google sync, translation retries) runs from
cPanel cron jobs, backups are a cron job too, and the two "Cloudflare"
translation services aren't available (Google, DeepL, Azure, Amazon and
Anthropic are).

Replace `USER` below with your cPanel username, and `taskly-app` with the
folder you choose.

## 0. Check your hosting

cPanel runs Node.js apps with one of two tools, under **Software**:

- **Setup Node.js App** on CloudLinux servers.
- **Application Manager** on other servers (AlmaLinux, Rocky). The zawyh server
  is one of these. If it's missing, someone with WHM turns it on: **EasyApache 4
  → Customize**, switch on `mod_passenger` (Apache Modules) and `ea-nodejs22` or
  newer (Additional Packages), **Provision**, then tick **Application Manager**
  in **Feature Manager**. Or as root:
  `dnf install -y ea-apache24-mod-passenger ea-nodejs22`.

The steps below are for Setup Node.js App, with notes where Application Manager
differs.

- It must offer **Node.js 22.13 or newer** (24 is best). Taskly's database uses
  the SQLite built into Node. With Application Manager, check with
  `/opt/cpanel/ea-nodejs22/bin/node -v` (or the newest `ea-nodejs*` folder).
- You'll also want **Advanced → Terminal** (or SSH) for the database commands.
  Without it, ask your host to run them, or use the **Run JS script** box on the
  Node.js app page where your host offers it.
- Plan for about **500 MB of memory** for the app. Small shared plans may be too tight.

Neither tool, or only older Node versions: cPanel can't run Taskly.
Stay on Cloudflare.

## 1. Create the subdomain

1. **Domains → Create a New Domain:** `taskly.zawyh.com`. Untick "Share
   document root"; the folder it suggests is fine (the Node app takes over the address).
2. **SSL/TLS Status:** run **AutoSSL** for `taskly.zawyh.com` until it has a
   valid certificate. Taskly needs https (sign-in cookies, push, installing the app).

## 2. Build the upload package (on your computer)

In the Taskly folder:

```bash
git pull
yarn install
yarn build:cpanel
```

This makes `cpanel-build/taskly-cpanel.tar.gz` (about 6 MB): the server,
everything it needs (`node_modules` included), the migrations and the database
tool. It never contains your database or local secrets.

## 3. Create the Node.js app

**Setup Node.js App → Create Application:**

| Field | Value |
|---|---|
| Node.js version | 24 (or the newest ≥ 22.13) |
| Application mode | Production |
| Application root | `taskly-app` (outside `public_html`) |
| Application URL | `taskly.zawyh.com` |
| Application startup file | `server.js` |

Add these **environment variables** (same page, then **Save**):

| Name | Value |
|---|---|
| `TASKLY_RUNTIME` | `node` |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | `https://taskly.zawyh.com` |
| `ENCRYPTION_KEY` | **the same value as on Cloudflare** (see below) |
| `CRON_SECRET` | a long random string, e.g. from `openssl rand -base64 32` |
| `VAPID_SUBJECT` | `mailto:you@zawyh.com` |

`ENCRYPTION_KEY` protects the passwords and keys saved in Platform → Settings
(mail password, Google client secret, translation key) and people's Google
connections. With the same key they keep working. Cloudflare can't show a
secret again, so use your saved copy. If it's lost, set a new random key: then
re-enter those passwords in Platform → Settings after the move, and people
reconnect Google in Settings.

Optional: `TASKLY_DB_PATH` (default `data/taskly.db` inside the app folder).

**Don't press "Run NPM Install".** The package already has its `node_modules`.

**With Application Manager instead:** **Register Application** with name
`taskly`, deployment domain `taskly.zawyh.com`, base URL `/`, application path
`taskly-app`, environment **Production**, and the same environment variables.
There's no startup file field: it always starts `app.js`, which the package
includes (it starts `server.js`). Don't press **Ensure dependencies**.

## 4. Upload

1. **File Manager →** open `taskly-app`. Delete the sample files cPanel put
   there (`app.js`, `public/`, …), but never a `data` folder.
2. **Upload** `taskly-cpanel.tar.gz`, then right-click it → **Extract** (into
   `taskly-app`). You should see `server.js`, `.next`, `node_modules`,
   `public`, `migrations` and `scripts`. Delete the `.tar.gz`.

## 5. Move the data from Cloudflare

Pick a quiet moment: anything saved on the Cloudflare version after the export
isn't carried over.

On your computer:

```bash
npx wrangler d1 export DB --remote --output taskly.sql
```

Upload `taskly.sql` into `taskly-app` (File Manager). Then in cPanel
**Terminal**, first run the "Enter to the virtual environment" command shown at
the top of the Node.js app page (it looks like
`source /home/USER/nodevenv/taskly-app/24/bin/activate && cd /home/USER/taskly-app`;
with Application Manager, run
`export PATH=/opt/cpanel/ea-nodejs22/bin:$PATH && cd /home/USER/taskly-app` instead), then:

```bash
node scripts/cpanel-db.mjs import taskly.sql
node scripts/cpanel-db.mjs migrate
rm taskly.sql
```

Delete `taskly.sql` afterwards: it contains everyone's data and password hashes.
(The "ExperimentalWarning: SQLite" line is normal.)

New install without Cloudflare data: skip the import, run `migrate`, then
create the first operator on your computer with
`node scripts/create-operator.mjs --name "…" --email … --out operator.sql`,
upload it, and run `node scripts/cpanel-db.mjs run operator.sql` (then delete it).

## 6. Start it

On the Node.js app page press **Restart** (Application Manager: in Terminal,
`mkdir -p tmp && touch tmp/restart.txt` in `taskly-app`), then open
`https://taskly.zawyh.com` and sign in.

## 7. Scheduled work and backups (cPanel → Cron Jobs)

Add three cron jobs (put your `CRON_SECRET` in the first two):

| When | Command |
|---|---|
| Every 5 minutes (`*/5 * * * *`) | `curl -fsS -X POST -H "Authorization: Bearer CRON_SECRET" "https://taskly.zawyh.com/api/cron?job=frequent" > /dev/null` |
| Every hour (`0 * * * *`) | `curl -fsS -X POST -H "Authorization: Bearer CRON_SECRET" "https://taskly.zawyh.com/api/cron?job=hourly" > /dev/null` |
| Daily at 03:00 (`0 3 * * *`) | `cd /home/USER/taskly-app && /home/USER/nodevenv/taskly-app/24/bin/node scripts/cpanel-db.mjs backup > /dev/null 2>&1` |

The first runs Google sync and translation retries, the second due date
reminders. The backup keeps the newest 14 copies in `/home/USER/taskly-app/backups/`
(download one now and then, or include it in your cPanel backups). If the
`node` path differs, run the "Enter to the virtual environment" command, then
`which node`, and use that path. With Application Manager it's
`/opt/cpanel/ea-nodejs22/bin/node`.

## 8. Settings after the move

Sign in as the platform operator, **Platform → Settings**:

1. **App address:** `https://taskly.zawyh.com`, used in email links and Google Calendar.
2. **Google sign-in** (if used): add `https://taskly.zawyh.com/api/google/callback`
   as a redirect URI on the OAuth client in Google Cloud.
3. **Email / Translation:** use **Send test email** and **Test translation**. If
   either fails after a new `ENCRYPTION_KEY`, enter the password or key again.
   If you used a Cloudflare translation service, pick another one.
4. **Push notifications:** the keys move with the data, but each person turns
   push on again in Settings (browsers tie it to the address).

Everyone signs in once at the new address. People who installed the app on
their phone or computer reinstall it from `taskly.zawyh.com`.

## 9. Turn off the Cloudflare copy

Once `taskly.zawyh.com` works, stop the Cloudflare version so nobody keeps
working in the old database, and its scheduled jobs don't send duplicate reminders:
in the Cloudflare dashboard, **Workers & Pages → zawyh → Settings**, delete the
**Cron Triggers** and turn off the **workers.dev** route. Keep the D1 database
for a while as an extra backup.

## Updating to a new version

1. On your computer: `git pull`, `yarn install`, `yarn build:cpanel`.
2. Upload and extract the new `.tar.gz` into `taskly-app`, replacing files
   (the `data` folder isn't in the package, so the database stays).
3. In Terminal (after "Enter to the virtual environment", or the `export PATH`
   line with Application Manager): `node scripts/cpanel-db.mjs migrate`.
4. **Restart** the app (Application Manager: `touch tmp/restart.txt`).

## If something goes wrong

- **Blank page or "Incomplete response":** check the app's log, `stderr.log`
  in `taskly-app` (or set a log file on the Node.js app page; with Application
  Manager, Apache's error log, `/etc/apache2/logs/error_log`, as root). A missing
  `TASKLY_RUNTIME=node` shows up as a Cloudflare error there.
- **Signed out on every page:** the site isn't on https, or `APP_ORIGIN` doesn't match the address.
- **No reminders:** check the cron jobs' emails. A 401 means the `CRON_SECRET` differs.
- **App restarts or is killed:** the plan's memory limit is too low; ask your host.
- **Restore a backup:** stop the app, replace `data/taskly.db` with a copy from
  `backups/` (and delete `data/taskly.db-wal` and `-shm` if present), start the app.
