import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pino from 'pino';
import { handleWebhook } from './webhook-handler.js';
import { handleTelegramUpdate } from './telegram-handler.js';
import { registerTelegramWebhook } from './telegram.js';
import { startWeeklySummaryJob } from './weekly-summary.js';
import { api } from './api.js';

const log = pino({ name: 'server', level: process.env.LOG_LEVEL || 'info' });
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

for (const key of [
  'DATABASE_URL',
  'WA_VERIFY_TOKEN',
  'WA_APP_SECRET',
  'WA_ACCESS_TOKEN',
  'WA_PHONE_NUMBER_ID',
  'APP_JWT_SECRET',
]) {
  if (!process.env[key]) log.warn(`env ${key} is not set — check your .env`);
}

export const app = express();

// Behind nginx on the VPS: trust the proxy so req.ip and rate limiting see the
// real client address rather than 127.0.0.1.
app.set('trust proxy', 1);

// BigInt amounts would crash JSON.stringify; make every res.json() BigInt-safe.
app.set('json replacer', (key, value) => (typeof value === 'bigint' ? value.toString() : value));

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Dashboard API. Mounted before the static handler so /api never hits a file.
app.use('/api', express.json({ limit: '100kb' }), api);

// PWA dashboard (index.html, app.js, styles.css, manifest, service worker).
app.use(
  express.static(publicDir, {
    setHeaders: (res, filePath) => {
      // The service worker must never be cached, or clients get stuck on an old build.
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// Webhook verification handshake — Meta calls this once when you save the
// webhook URL in the App Dashboard.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    log.info('webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Keep the RAW body bytes: the X-Hub-Signature-256 HMAC must be computed over
// exactly what Meta sent, never over a re-serialized object.
const jsonWithRawBody = express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});

app.post('/webhook', jsonWithRawBody, (req, res) => {
  if (!verifySignature(req)) {
    log.warn('rejected webhook: invalid X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  // Ack immediately — Meta retries (and eventually disables) slow webhooks.
  res.sendStatus(200);
  handleWebhook(req.body).catch((err) => log.error({ err }, 'async webhook processing failed'));
});

function verifySignature(req) {
  const signature = req.get('x-hub-signature-256');
  if (!signature || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET ?? '').update(req.rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Telegram webhook. Telegram echoes TG_WEBHOOK_SECRET in this header on every
// call, so a mismatch means the request didn't come from Telegram — reject it.
app.post('/telegram/webhook', express.json({ limit: '256kb' }), (req, res) => {
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    log.warn('rejected Telegram webhook: bad secret token');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast; Telegram retries on non-200
  handleTelegramUpdate(req.body).catch((err) => log.error({ err }, 'async Telegram processing failed'));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  log.info(`wa-finance-bot backend listening on :${port}`);
  startWeeklySummaryJob();
  registerTelegramWebhook(); // no-op unless TG_BOT_TOKEN + public APP_PUBLIC_URL are set
});
