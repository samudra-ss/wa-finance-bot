// Dev helper: simulates a Meta WhatsApp Cloud API webhook delivery against the
// local server, with a valid X-Hub-Signature-256 computed from WA_APP_SECRET.
// Lets you exercise the entire parse -> store -> reply flow without Meta.
// (The outbound reply will still try to hit the Graph API; with fake
// credentials it just logs a send error — watch the server logs.)
//
// Usage:
//   node scripts/send-test-webhook.js "makan siang 50rb"
//   node scripts/send-test-webhook.js saldo

import 'dotenv/config';
import crypto from 'node:crypto';

const text = process.argv.slice(2).join(' ') || 'makan siang 50rb';
const waId = process.env.TEST_WA_ID || '6281234567890';
const port = process.env.PORT || 3000;

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '0',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '15550000000',
              phone_number_id: process.env.WA_PHONE_NUMBER_ID || '0',
            },
            contacts: [{ profile: { name: 'Test User' }, wa_id: waId }],
            messages: [
              {
                from: waId,
                id: `wamid.test.${crypto.randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const signature =
  'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET ?? '').update(body, 'utf8').digest('hex');

const res = await fetch(`http://localhost:${port}/webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': signature,
  },
  body,
});

console.log(`POST /webhook -> ${res.status} ${await res.text()}`);
console.log(`sent as ${waId}: "${text}"`);
console.log('check the server logs for the parsed transaction and the (attempted) WhatsApp reply.');
