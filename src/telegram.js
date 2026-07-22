// Telegram Bot API client. Far simpler than WhatsApp: no business verification,
// no templates, no 24h window, no signed-request dance. One bot token from
// @BotFather is the whole setup, and the app registers its own webhook on boot.

import pino from 'pino';

const log = pino({ name: 'telegram', level: process.env.LOG_LEVEL || 'info' });

const apiBase = () => `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}`;

/** Send a plain-text message to a chat. Returns the API body, or null on failure. */
export async function sendMessage(chatId, text) {
  if (!process.env.TG_BOT_TOKEN) {
    log.warn('TG_BOT_TOKEN not set — cannot send Telegram message');
    return null;
  }
  try {
    const res = await fetch(`${apiBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      log.error({ status: res.status, description: body.description, chatId }, 'Telegram send failed');
      return null;
    }
    return body;
  } catch (err) {
    log.error({ err, chatId }, 'Telegram send threw');
    return null;
  }
}

/**
 * Point Telegram at our webhook. Idempotent — safe to call on every boot.
 * Telegram will POST updates to <APP_PUBLIC_URL>/telegram/webhook and echo
 * TG_WEBHOOK_SECRET back in the X-Telegram-Bot-Api-Secret-Token header.
 */
export async function registerTelegramWebhook() {
  const token = process.env.TG_BOT_TOKEN;
  const base = process.env.APP_PUBLIC_URL;
  if (!token) {
    log.info('TG_BOT_TOKEN not set — Telegram disabled');
    return;
  }
  if (!base || base.startsWith('http://localhost')) {
    log.warn('APP_PUBLIC_URL is missing or local — skipping Telegram webhook registration (Telegram needs a public HTTPS URL)');
    return;
  }
  const url = `${base.replace(/\/$/, '')}/telegram/webhook`;
  try {
    const res = await fetch(`${apiBase()}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: process.env.TG_WEBHOOK_SECRET || undefined,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.ok) log.info({ url }, 'Telegram webhook registered');
    else log.error({ description: body.description }, 'Telegram setWebhook failed');
  } catch (err) {
    log.error({ err }, 'Telegram setWebhook threw');
  }
}
