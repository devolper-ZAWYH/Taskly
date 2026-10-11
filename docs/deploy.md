# Deploying Taskly to a new Cloudflare account

How to put Taskly on Zawyh's own Cloudflare account, starting from nothing.
Everything below runs from the `Taskly` folder. One build serves every
deployment: per-deployment settings live in Platform → Settings, not in code.

## 1. Sign in to Zawyh's Cloudflare account

Wrangler acts on whichever account you're signed in to. Check it first:

```bash
npx wrangler whoami
```

If it shows another account, sign out and sign in as Zawyh:

```bash
npx wrangler logout
```

```bash
npx wrangler login
```

(In CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.)

**Plan.** Free works. **Workers Paid ($5/month)** is worth it in production:
higher limits, and Workers AI keeps working past the free daily allowance if
you use Cloudflare for translation.

## 2. Create the database

```bash
npx wrangler d1 create zawyh-db
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing the one there
(`d1_databases[0].database_id`). Commit that change.

> The local database is tied to that ID too, so `yarn dev` starts with an empty
> one: run `yarn db:migrate:local` and `yarn db:seed:local` again.

## 3. Create the tables

```bash
yarn db:migrate:remote
```

This applies every file in `migrations/`. Run it again after any update that
adds a migration, before deploying that update.

## 4. Deploy

```bash
yarn deploy
```

The first time on a new account it may stop with "You need to register a
workers.dev subdomain": open the link it prints, pick a subdomain, and run it
again.

It prints the address, `https://zawyh.<subdomain>.workers.dev`. The Workers AI
binding and the cron jobs (reminders hourly; Google sync and translation
retries every 5 minutes) come from `wrangler.jsonc` automatically.

## 5. Set the one secret

`ENCRYPTION_KEY` encrypts the secrets saved in Platform → Settings and the
Google tokens. Generate 32 random bytes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then paste it when asked:

```bash
npx wrangler secret put ENCRYPTION_KEY
```

**Keep a copy somewhere safe and never change it.** A new key can't read what
the old one encrypted (you'd have to re-enter every secret in the console and
everyone would reconnect Google).

## 6. Create the first operator

No demo data goes to production. Create one operator account:

```bash
node scripts/create-operator.mjs --name "Your name" --email you@zawyh.com --out operator.sql
```

```bash
npx wrangler d1 execute DB --remote --file operator.sql
```

It prints a password once. Sign in with it, change it in Settings, and delete
`operator.sql`. To choose the password yourself, add `--ask-password`: it's
asked twice and never shown.

## 7. Platform → Settings

Sign in as the operator and open **Platform → Settings**:

1. **App address:** the address from step 4 (or your custom domain). Email
   links and Google Calendar updates use it.
2. **Email:** the cPanel mailbox (`mail.zawyh.com`, port 465, TLS on), then
   **Send test email**. In cPanel → Email Deliverability, make sure SPF and
   DKIM are valid, or mail lands in spam.
3. **Push notifications:** **Generate new keys**.
4. **Translation:** pick a service, then **Test translation**.
5. **Google sign-in** (only for Google sync): the OAuth client's ID and
   secret; add the redirect URI shown there to the client in Google Cloud.

Then create workspaces (Platform → Accounts) and invite people.

## Custom domain (optional)

To serve Taskly at, say, `tasks.zawyh.com`, the domain's DNS must be on
Cloudflare: add `zawyh.com` to the account and switch its nameservers (cPanel
mail keeps working if its MX, SPF and DKIM records are copied over). Then add
the custom domain to the Worker (Workers → zawyh → Settings → Domains) and put
the new address in Platform → Settings → App address.

## After deploying

- **Logs:** `npx wrangler tail`, or the Worker's Observability tab.
- **Updates:** pull, `yarn db:migrate:remote`, `yarn deploy`.
- **Rollback:** `npx wrangler rollback` (code only; migrations aren't undone).
- **Backups:** D1 Time Travel can restore the database to an earlier minute
  (`npx wrangler d1 time-travel restore`).
