# WA Finance Bot — Backend + Dashboard

WhatsApp-first personal finance tracker for Indonesian users (all amounts IDR).
Users log transactions by texting a WhatsApp bot ("makan siang 50rb", "gaji 10jt");
the backend parses, categorizes, stores them in a Postgres ledger, and replies with
the remaining category budget. A cron job pushes a weekly summary every Sunday
18:00 WIB. A mobile-first installable web dashboard (PWA, works like an Android
app — no Play Store needed) shows the same data: net worth, spending by category,
loan tracker with WhatsApp reminders, savings goals, and a financial health score.

**Stack:** Node.js 22 LTS · Express 5 · Prisma + PostgreSQL · Meta WhatsApp Cloud API · node-cron · pino · vanilla-JS PWA (no build step)

## Project layout

```
src/server.js           Express app: webhook, dashboard API mount, static PWA, health
src/webhook-handler.js  Message router: commands, dedup, auto-register, atomic ledger writes
src/parser.js           Deterministic Indonesian money/category parser (pure functions)
src/whatsapp.js         Graph API sender (sendText, sendTemplate) + formatIDR
src/weekly-summary.js   node-cron Sunday-18:00 Asia/Jakarta summary via template
src/auth.js             Dashboard login: WhatsApp-code -> JWT (no passwords, no SMS)
src/finance.js          Health-score + wealth-level calculations (ported from the Excel template)
src/api.js              REST API the dashboard calls (/api/dashboard, /api/transactions, /api/auth/verify)
src/db.js               Shared PrismaClient
prisma/schema.prisma    User, Account, Category, Transaction, Budget, Goal, Loan, LoginCode, ProcessedMessage
public/                 The PWA dashboard (index.html, app.js, styles.css, manifest, service worker, icons)
scripts/send-test-webhook.js  Signed fake webhook for local testing
test/parser.test.js     node:test suite for the parser
docker-compose.yml      Local PostgreSQL (port 5433, so it never clashes with a system Postgres)
```

## Prerequisites

- Node.js 22 LTS
- PostgreSQL 15+ (local, or a free Neon/Railway instance)
- A Meta developer account (for the WhatsApp part — everything else runs without it)

## Quickstart (local)

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL at minimum
npx prisma migrate dev --name init
npm run dev                 # starts on :3000 with --watch
```

Run the parser tests:

```bash
npm test
```

Exercise the full webhook flow without Meta (uses WA_APP_SECRET from .env to sign):

```bash
node scripts/send-test-webhook.js "makan siang 50rb"
node scripts/send-test-webhook.js "gaji 10jt"
node scripts/send-test-webhook.js saldo
node scripts/send-test-webhook.js "budget makan 2jt"
node scripts/send-test-webhook.js undo
```

The server acks 200, parses the message, writes the transaction, and then tries to
reply via the Graph API — with placeholder credentials that send fails and is
logged, which is expected in local dev. Watch the server logs.

## Meta WhatsApp Cloud API setup

1. **Create the app**: developers.facebook.com > My Apps > Create App > type **Business**. Add the **WhatsApp** product.
2. **Test number**: WhatsApp > API Setup gives you a free test phone number and a temporary (24h) token. Add your own phone as a recipient and send yourself the hello-world template to confirm the pipe works.
3. **Permanent token**: Meta Business Settings > Users > **System users** > create one (admin role), assign the app with `whatsapp_business_messaging` + `whatsapp_business_management`, then **Generate token** with no expiry. Put it in `WA_ACCESS_TOKEN`.
4. **IDs and secret**: copy the **Phone number ID** from API Setup into `WA_PHONE_NUMBER_ID`; copy App settings > Basic > **App secret** into `WA_APP_SECRET`.
5. **Expose your local server**: `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`).
6. **Subscribe the webhook**: App Dashboard > WhatsApp > Configuration > Webhook: callback URL `https://<your-tunnel>/webhook`, verify token = your `WA_VERIFY_TOKEN` value. Meta calls `GET /webhook` and the server echoes the challenge.
7. **Webhook fields**: subscribe to **messages** (that one field covers inbound messages; status callbacks arrive on it too and are ignored by the handler).
8. Message the test number from your phone: "makan 20rb". You should get the confirmation reply.

### Register the weekly_summary template

Business-initiated messages (the Sunday summary) are outside the 24h service
window and must use an approved template. In WhatsApp Manager > Account tools >
**Message templates** > Create:

- Name: `weekly_summary` · Category: **Utility** · Language: **Indonesian (id)**
- Body:

```
Ringkasan keuangan minggu ini 📊
Pemasukan: {{1}}
Pengeluaran: {{2}}
Pengeluaran terbesar: {{3}}
Progres target: {{4}}
```

Provide sample values when prompted (e.g. `Rp5.000.000`, `Rp3.250.000`,
`Konsumsi Rp1.200.000, Transportasi Rp800.000`, `Liburan 45%`). Approval is
usually minutes for Utility templates. The exact same body lives as a comment in
`src/weekly-summary.js`.

Trigger a summary run manually:

```bash
node -e "import('./src/weekly-summary.js').then(m => m.runWeeklySummary())"
```

## Bot commands

| Message | Effect |
|---|---|
| `makan siang 50rb`, `bensin 25k`, `belanja 10.000` | log expense (category via alias table) |
| `gaji 10jt`, `bonus 500rb` | log income |
| `saldo` | balances per account + total |
| `budget` / `budget makan 2jt` | view / set this month's category budget |
| `transfer 500rb bca ke mandiri` | pindah kas between accounts |
| `utang Budi 200rb jatuh tempo 25/8` | record borrowed money |
| `piutang Sari 500rb` | record money lent |
| `target liburan 5jt tanggal 31/12` | create a savings goal |
| `undo` / `hapus` | soft-delete the last transaction and restore the balance |
| `stop` / `mulai` | opt out of / back into the Sunday weekly summary |
| `login` / `masuk` | get a 6-digit code to sign into the dashboard |

## The dashboard (PWA)

Open `http://localhost:3000` (or your real domain in production) in a phone
browser. There's no separate app to build or install from a store:

1. On WhatsApp, send **login** to the bot. Because you just messaged it, the
   24-hour service window is open, so the code goes out as a free plain-text
   reply — no Meta template approval needed for this.
2. Type your WhatsApp number and the 6-digit code into the page.
3. To make it feel like an installed Android app: open the browser menu →
   **Add to Home screen** (Chrome) or **Install app**. It gets its own icon,
   opens full-screen (no address bar), and the last-loaded data is cached so
   it still opens (read-only) with no signal.

Screens: **Ringkasan** (net worth, wealth level 0–6, spending donut, account
balances, recent activity), **Transaksi** (full history with filters),
**Utang & Piutang** (loan tracker — "Kirim pengingat WA" opens WhatsApp with a
pre-filled reminder message to the debtor, sent from *your own* number so it
needs no template approval or their prior opt-in), **Target** (savings goals
with a projected completion date from your current savings rate), and
**Saran** (the 8-point financial health check from the Excel template, this
month's budget vs. actual, and a few rule-based tips).

Login tokens are signed with `APP_JWT_SECRET` — every real deployment must set
its own random value (`.env.example` explains how); everyone using a shared or
default secret would be able to forge each other's login tokens.

## Design notes

- **Amounts are BigInt rupiah** end to end (Prisma `BigInt` ↔ JS `bigint`). IDR has
  no usable subunit, so integers are exact. `JSON.stringify` throws on BigInt:
  the Express `json replacer` setting stringifies them in API responses, and all
  WhatsApp text is formatted with `formatIDR` before serialization.
- **Webhook security**: `POST /webhook` verifies `X-Hub-Signature-256` with an
  HMAC over the **raw body bytes** (`express.json`'s `verify` callback) using
  `crypto.timingSafeEqual`, acks 200 immediately, and processes async.
- **Idempotency**: every inbound message is claimed first via
  `ProcessedMessage` (wamid primary key) — this also covers command messages
  (utang/piutang/target/budget) that don't create a Transaction row. The claim
  is released on a processing error so Meta's retry gets another attempt.
  `Transaction.waMessageId` (UNIQUE) is kept as belt-and-braces plus traceability.
- **Atomicity**: every log/transfer/undo is a single `prisma.$transaction` that
  writes the ledger row and updates the running account balance(s) together.
- **Dashboard auth has no passwords**: the WhatsApp number *is* the identity.
  A login code proves the user controls that number and doubles as opening the
  free service window — see `src/auth.js`. Tokens are hand-rolled HS256 JWTs
  (`node:crypto` only, zero extra dependency) valid 30 days.
- **The service worker (`public/sw.js`) never caches `/api/*`.** It only caches
  the static app shell for offline loading. Financial data is never written to
  disk cache — only kept in `sessionStorage` as a last-resort offline view,
  which clears when the tab closes.
