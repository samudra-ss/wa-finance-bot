// Telegram receive adapter: turns a Telegram "update" into the channel-agnostic
// ctx and hands it to the shared router (handleInbound in webhook-handler.js).

import pino from 'pino';
import { handleInbound } from './webhook-handler.js';
import { sendMessage } from './telegram.js';

const log = pino({ name: 'telegram-handler', level: process.env.LOG_LEVEL || 'info' });

export async function handleTelegramUpdate(update) {
  const msg = update?.message;
  if (!msg) return; // edited_message / callback_query / etc. — we only subscribe to 'message'

  const chatId = msg.chat?.id;
  if (!chatId) return;

  const raw = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!raw) {
    await sendMessage(chatId, 'Maaf, aku hanya bisa membaca pesan teks. Contoh: "makan siang 50rb"').catch(() => {});
    return;
  }

  // Telegram commands arrive as "/saldo" or "/saldo@MyBot" — strip the slash and
  // any @mention so they hit the same command router as WhatsApp. "/start" maps
  // to the help/welcome text.
  let text = raw;
  if (text.startsWith('/')) {
    text = text.slice(1).replace(/@\w+/g, '').trim();
    if (text.toLowerCase() === 'start') text = 'help';
  }

  const from = msg.from ?? {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null;

  const ctx = {
    channel: 'TELEGRAM',
    identity: `tg:${chatId}`,
    externalId: `tg:${update.update_id}`,
    text,
    name,
    reply: (t) => sendMessage(chatId, t),
  };

  try {
    await handleInbound(ctx);
  } catch (err) {
    log.error({ err, updateId: update.update_id }, 'failed to handle Telegram update');
  }
}
