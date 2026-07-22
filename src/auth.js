// Dashboard authentication.
//
// Flow: the user sends "login" to the WhatsApp bot. That inbound message both
// proves they control the number and opens the 24h customer-service window, so
// the 6-digit code can be sent as a FREE free-form message (no approved
// template needed). They type the code into the dashboard and get a token.
//
// Tokens are HS256 JWTs signed with APP_JWT_SECRET. Hand-rolled over node:crypto
// so the server keeps zero auth dependencies.

import crypto from 'node:crypto';
import { prisma } from './db.js';

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days — personal app, long session

function secret() {
  const s = process.env.APP_JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('APP_JWT_SECRET is missing or too short (needs 16+ chars)');
  }
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function signToken(payload, ttlSec = TOKEN_TTL_SEC) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Create a login code for a wa_id and return the PLAIN code (to send via WhatsApp). */
export async function issueLoginCode(waId) {
  // Invalidate any outstanding codes for this number.
  await prisma.loginCode.updateMany({
    where: { waId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.loginCode.create({
    data: { waId, codeHash: sha256(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return code;
}

/**
 * Check a submitted code. Returns the user on success, or a reason string.
 * @returns {Promise<{ok: true, user: object} | {ok: false, reason: string}>}
 */
export async function redeemLoginCode(waId, code) {
  const row = await prisma.loginCode.findFirst({
    where: { waId, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { ok: false, reason: 'Kode tidak ditemukan atau sudah kedaluwarsa. Kirim "login" lagi ke bot.' };
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'Terlalu banyak percobaan. Kirim "login" lagi ke bot untuk kode baru.' };
  }

  const submitted = Buffer.from(sha256(String(code ?? '').trim()));
  const stored = Buffer.from(row.codeHash);
  const match = submitted.length === stored.length && crypto.timingSafeEqual(submitted, stored);

  if (!match) {
    await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'Kode salah.' };
  }

  await prisma.loginCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  const user = await prisma.user.findUnique({ where: { waId } });
  if (!user) return { ok: false, reason: 'Nomor belum terdaftar. Kirim satu transaksi ke bot dulu.' };
  return { ok: true, user };
}

/** Express middleware: requires a valid Bearer token, sets req.userId. */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload?.sub) return res.status(401).json({ error: 'unauthorized' });
  req.userId = payload.sub;
  req.waId = payload.waId;
  next();
}
