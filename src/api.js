// REST API consumed by the PWA dashboard.
// Every route except /auth/* requires a Bearer token (see auth.js).

import express from 'express';
import pino from 'pino';
import { prisma } from './db.js';
import { redeemLoginCode, signToken, requireAuth } from './auth.js';
import { healthCheck, wealthLevel, goalProjection } from './finance.js';

const log = pino({ name: 'api', level: process.env.LOG_LEVEL || 'info' });
export const api = express.Router();

// BigInt rupiah -> Number for JSON. IDR values stay far below 2^53.
const n = (v) => (typeof v === 'bigint' ? Number(v) : v ?? 0);

/** Accepts 08xx, 628xx, +628xx, or spaced/dashed variants -> "628xx" (wa_id form). */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('8')) return '62' + digits;
  return digits;
}

function monthKey(date = new Date(), tz = 'Asia/Jakarta') {
  return date.toLocaleDateString('sv-SE', { timeZone: tz }).slice(0, 7);
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: new Date(`${month}-01T00:00:00+07:00`), end: new Date(`${next}-01T00:00:00+07:00`) };
}

// ------------------------------------------------------------------ auth

api.post('/auth/verify', async (req, res) => {
  // Magic link (Telegram or WhatsApp) sends the exact identity; the manual form
  // sends a phone number that we normalize to the wa_id form.
  const rawIdentity = typeof req.body?.identity === 'string' ? req.body.identity.trim() : '';
  const waId = rawIdentity || normalizePhone(req.body?.phone);
  const code = String(req.body?.code ?? '').replace(/\D/g, '');
  if (!waId || code.length !== 6) {
    return res.status(400).json({ error: 'Data login tidak lengkap. Kirim "login" lagi ke bot.' });
  }
  try {
    const result = await redeemLoginCode(waId, code);
    if (!result.ok) return res.status(401).json({ error: result.reason });
    const token = signToken({ sub: result.user.id, waId: result.user.waId });
    log.info({ waId }, 'dashboard login');
    return res.json({
      token,
      user: { id: result.user.id, name: result.user.name, waId: result.user.waId },
    });
  } catch (err) {
    log.error({ err }, 'login failed');
    return res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
});

api.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ id: user.id, name: user.name, waId: user.waId, weeklyOptIn: user.weeklyOptIn });
});

// ------------------------------------------------------------------ dashboard

api.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const month = monthKey();
    const { start, end } = monthRange(month);
    // Trailing 3 months for a stable "average burn" figure.
    const trailStart = new Date(start);
    trailStart.setUTCMonth(trailStart.getUTCMonth() - 3);

    const [accounts, loans, goals, budgets, categories, recent, monthTx, trailExpense] = await Promise.all([
      prisma.account.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.loan.findMany({ where: { userId, settledAt: null }, orderBy: [{ dueDate: 'asc' }] }),
      prisma.goal.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.budget.findMany({ where: { userId, month }, include: { category: true } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.transaction.findMany({
        where: { userId, deletedAt: null },
        include: { category: true, account: true },
        orderBy: { occurredAt: 'desc' },
        take: 10,
      }),
      prisma.transaction.findMany({
        where: { userId, deletedAt: null, occurredAt: { gte: start, lt: end } },
        select: { type: true, amount: true, categoryId: true },
      }),
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { userId, deletedAt: null, type: 'EXPENSE', occurredAt: { gte: trailStart, lt: end } },
      }),
    ]);

    const catName = new Map(categories.map((c) => [c.id, c.name]));

    const cash = accounts.reduce((s, a) => s + n(a.balance), 0);
    const utang = loans.filter((l) => l.direction === 'UTANG').reduce((s, l) => s + n(l.remaining), 0);
    const piutang = loans.filter((l) => l.direction === 'PIUTANG').reduce((s, l) => s + n(l.remaining), 0);
    const netWorth = cash + piutang - utang;

    let monthlyIncome = 0;
    let monthlyExpense = 0;
    const byCategory = new Map();
    for (const t of monthTx) {
      const amt = n(t.amount);
      if (t.type === 'INCOME') monthlyIncome += amt;
      else if (t.type === 'EXPENSE') {
        monthlyExpense += amt;
        const key = t.categoryId ?? 'lainnya';
        byCategory.set(key, (byCategory.get(key) ?? 0) + amt);
      }
    }

    const avgMonthlyExpense = n(trailExpense._sum.amount) / 3;
    const features = { netWorth, monthlyIncome, monthlyExpense, cash, totalDebt: utang, avgMonthlyExpense };
    const health = healthCheck(features);
    const level = wealthLevel(features);
    const monthlySavings = monthlyIncome - monthlyExpense;

    const spending = [...byCategory.entries()]
      .map(([id, amount]) => ({ categoryId: id, name: catName.get(id) ?? 'Lainnya', amount }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      month,
      netWorth,
      cash,
      utang,
      piutang,
      monthlyIncome,
      monthlyExpense,
      monthlySavings,
      avgMonthlyExpense,
      health,
      level,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, balance: n(a.balance), isDefault: a.isDefault })),
      spending,
      budgets: budgets.map((b) => {
        const spent = byCategory.get(b.categoryId) ?? 0;
        return {
          id: b.id,
          category: b.category.name,
          limit: n(b.limit),
          spent,
          remaining: n(b.limit) - spent,
        };
      }),
      goals: goals.map((g) => {
        const saved = n(g.saved);
        const target = n(g.target);
        return {
          id: g.id,
          name: g.name,
          saved,
          target,
          pct: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
          deadline: g.deadline ? g.deadline.toISOString().slice(0, 10) : null,
          projection: goalProjection(saved, target, monthlySavings),
        };
      }),
      loans: loans.map((l) => ({
        id: l.id,
        direction: l.direction,
        name: l.counterpartyName,
        phone: l.counterpartyPhone,
        principal: n(l.principal),
        remaining: n(l.remaining),
        dueDate: l.dueDate ? l.dueDate.toISOString().slice(0, 10) : null,
      })),
      recent: recent.map((t) => ({
        id: t.id,
        type: t.type,
        amount: n(t.amount),
        category: t.category?.name ?? null,
        account: t.account?.name ?? null,
        note: t.note,
        occurredAt: t.occurredAt.toISOString(),
        source: t.source,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ transactions

api.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Math.max(Number(req.query.offset) || 0, 0);
    const type = req.query.type;
    const where = { userId: req.userId, deletedAt: null };
    if (type && ['INCOME', 'EXPENSE', 'TRANSFER'].includes(type)) where.type = type;

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { category: true, account: true },
        orderBy: { occurredAt: 'desc' },
        take,
        skip,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      total,
      items: items.map((t) => ({
        id: t.id,
        type: t.type,
        amount: n(t.amount),
        category: t.category?.name ?? null,
        account: t.account?.name ?? null,
        note: t.note,
        occurredAt: t.occurredAt.toISOString(),
        source: t.source,
      })),
    });
  } catch (err) {
    next(err);
  }
});

api.use((err, _req, res, _next) => {
  log.error({ err }, 'api error');
  res.status(500).json({ error: 'internal error' });
});
