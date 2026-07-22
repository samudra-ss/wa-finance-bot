import pino from 'pino';

const log = pino({ name: 'whatsapp', level: process.env.LOG_LEVEL || 'info' });

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';

/** Format a BigInt/number rupiah amount as "Rp1.234.567". */
export function formatIDR(value) {
  let n = typeof value === 'bigint' ? value : BigInt(value);
  const sign = n < 0n ? '-' : '';
  if (n < 0n) n = -n;
  const grouped = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}Rp${grouped}`;
}

async function callGraph(payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // payload must never contain BigInt — format amounts with formatIDR first.
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error({ status: res.status, error: body.error, to: payload.to }, 'WhatsApp send failed');
      return null;
    }
    return body;
  } catch (err) {
    log.error({ err, to: payload.to }, 'WhatsApp send threw');
    return null;
  }
}

/** Free-form text reply — only valid inside the 24h customer-service window. */
export async function sendText(to, body) {
  return callGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  });
}

/** Template message — required for business-initiated sends (weekly summary, reminders). */
export async function sendTemplate(to, templateName, components = [], languageCode = 'id') {
  return callGraph({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
}
