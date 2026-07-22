// Channel-agnostic message router.
//
// Both WhatsApp and Telegram feed the SAME logic through a small `ctx` object:
//   { channel, identity, externalId, text, name, reply(text), user }
// - channel:    'WHATSAPP' | 'TELEGRAM'  (stored on Transaction.source)
// - identity:   the User.waId key — phone for WhatsApp, "tg:<chatId>" for Telegram
// - externalId: unique per inbound message, used for idempotency
// - reply:      async (text) => void, bound to the right channel's send API
// - user:       attached after lookup/registration
//
// handleWebhook()   — WhatsApp (Meta Cloud API) adapter, builds ctx, calls handleInbound.
// handleInbound()   — shared: dedup, user lookup/register, route. Also called by
//                     src/telegram-handler.js.

import pino from 'pino';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import {
  parseMessage,
  extractMoney,
  matchAlias,
  DEFAULT_CATEGORIES,
  DEFAULT_ACCOUNTS,
  HELP_TEXT,
} from './parser.js';
import { sendText, formatIDR } from './whatsapp.js';
import { issueLoginCode } from './auth.js';

const log = pino({ name: 'router', level: process.env.LOG_LEVEL || 'info' });
const TZ = 'Asia/Jakarta';
const DAY_MS = 86_400_000;

const DUE_RE = /jatuh\s+tempo\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/i;
const DATE_RE = /tanggal\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/i;

// ---------------------------------------------------------------- WhatsApp adapter

/** Unwraps the Meta Cloud API envelope entry[].changes[].value and routes each message. */
export async function handleWebhook(payload) {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      if (value.statuses) continue; // sent/delivered/read callbacks — ignore
      for (const message of value.messages ?? []) {
        if (message.type !== 'text' || !message.text?.body) {
          await sendText(message.from, 'Maaf, untuk sekarang aku hanya bisa membaca pesan teks. Contoh: "makan siang 50rb"').catch(() => {});
          continue;
        }
        const contact =
          (value.contacts ?? []).find((c) => c.wa_id === message.from) ?? value.contacts?.[0] ?? null;
        const ctx = {
          channel: 'WHATSAPP',
          identity: message.from,
          externalId: message.id,
          text: message.text.body.trim(),
          name: contact?.profile?.name ?? null,
          reply: (t) => sendText(message.from, t),
        };
        try {
          await handleInbound(ctx);
        } catch (err) {
          log.error({ err, externalId: ctx.externalId }, 'failed to handle message');
        }
      }
    }
  }
}

// ---------------------------------------------------------------- shared core

/** Dedup by externalId, then route. Shared by both channels. */
export async function handleInbound(ctx) {
  // Idempotency gate: retried deliveries (and commands that create no Transaction
  // row) are claimed here first. Released on a processing error so a retry works.
  try {
    await prisma.processedMessage.create({ data: { wamid: ctx.externalId, waId: ctx.identity } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.info({ externalId: ctx.externalId }, 'duplicate delivery, skipped');
      return;
    }
    throw err;
  }

  try {
    await routeMessage(ctx);
  } catch (err) {
    await prisma.processedMessage.delete({ where: { wamid: ctx.externalId } }).catch(() => {});
    throw err;
  }
}

async function routeMessage(ctx) {
  let user = await prisma.user.findUnique({
    where: { waId: ctx.identity },
    include: { categories: true, accounts: true },
  });
  if (!user) {
    if (process.env.ALLOW_AUTO_REGISTER !== 'true') {
      await ctx.reply('Kamu belum terdaftar. Hubungi admin untuk mendaftar ya.');
      return;
    }
    user = await registerUser(ctx.identity, ctx.name);
    await ctx.reply(`Halo ${user.name ?? 'kak'}! Akun kamu sudah dibuat 🎉\n\n${HELP_TEXT}`);
  }
  ctx.user = user;

  // ---- Tier 0: command router ----
  const lower = ctx.text.toLowerCase();
  if (lower === 'saldo') return replySaldo(ctx);
  if (lower === 'help' || lower === 'bantuan' || lower === 'menu') return ctx.reply(HELP_TEXT);
  if (lower === 'undo' || lower === 'hapus') return undoLast(ctx);
  if (lower === 'budget') return replyBudgets(ctx);
  if (lower.startsWith('budget ')) return setBudget(ctx);
  if (lower === 'login' || lower === 'masuk') return sendLoginCode(ctx);
  if (lower === 'stop' || lower === 'berhenti') return setWeeklyOptIn(ctx, false);
  if (lower === 'mulai' || lower === 'lanjut') return setWeeklyOptIn(ctx, true);
  if (/^(transfer|pindah)\s/.test(lower)) return doTransfer(ctx);
  const loanMatch = lower.match(/^(utang|piutang)\s/);
  if (loanMatch) return createLoan(ctx, loanMatch[1]);
  if (lower.startsWith('target ')) return createGoal(ctx);

  // ---- Tier 1: deterministic transaction parser ----
  return logTransaction(ctx);
}

// The user just messaged us, so (on WhatsApp) the 24h window is open and this
// goes out free-form. The magic link logs them in with one tap on either channel.
async function sendLoginCode(ctx) {
  const code = await issueLoginCode(ctx.user.waId);
  const base = (process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const link = `${base}/?id=${encodeURIComponent(ctx.user.waId)}&code=${code}`;
  await ctx.reply(
    [
      `🔐 Kode login dashboard: ${code}`,
      '',
      'Berlaku 5 menit. Jangan bagikan ke siapa pun.',
      `Buka (tap): ${link}`,
    ].join('\n'),
  );
}

async function setWeeklyOptIn(ctx, optIn) {
  await prisma.user.update({ where: { id: ctx.user.id }, data: { weeklyOptIn: optIn } });
  await ctx.reply(
    optIn
      ? 'Oke, ringkasan mingguan aktif lagi setiap Minggu sore. 📊'
      : 'Ringkasan mingguan dimatikan. Ketik "mulai" kapan saja untuk mengaktifkan lagi.',
  );
}

async function registerUser(identity, name) {
  try {
    const user = await prisma.user.create({
      data: {
        waId: identity,
        phone: identity,
        name: name ?? null,
        categories: {
          create: DEFAULT_CATEGORIES.map((c) => ({ name: c.name, kind: c.kind, aliases: c.aliases })),
        },
        accounts: {
          create: DEFAULT_ACCOUNTS.map((a) => ({
            name: a.name,
            aliases: a.aliases,
            isDefault: Boolean(a.isDefault),
          })),
        },
      },
      include: { categories: true, accounts: true },
    });
    log.info({ identity, userId: user.id }, 'auto-registered new user');
    return user;
  } catch (err) {
    // Two first-messages racing: the loser of the unique(waId) race reuses the row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return prisma.user.findUnique({ where: { waId: identity }, include: { categories: true, accounts: true } });
    }
    throw err;
  }
}

// ---------------------------------------------------------------- transactions

async function logTransaction(ctx) {
  const user = ctx.user;
  const parsed = parseMessage(ctx.text, user.categories, user.accounts);
  if (!parsed.ok) {
    if (parsed.reason === 'AMBIGUOUS_AMOUNT') {
      await ctx.reply('Aku menemukan lebih dari satu angka 😅 Tulis satu nominal saja ya, contoh: "makan siang 50rb"');
    } else {
      await ctx.reply(`Hmm, aku belum paham pesan itu.\n\n${HELP_TEXT}`);
    }
    return;
  }

  const category = parsed.category ?? user.categories.find((c) => c.name === 'Lainnya') ?? null;
  const account = parsed.account ?? user.accounts.find((a) => a.isDefault) ?? user.accounts[0] ?? null;
  const occurredAt = new Date(Date.now() + parsed.dateOffsetDays * DAY_MS);
  const delta = parsed.type === 'INCOME' ? parsed.amount : -parsed.amount;

  const ops = [
    prisma.transaction.create({
      data: {
        userId: user.id,
        type: parsed.type,
        amount: parsed.amount,
        categoryId: category?.id ?? null,
        accountId: account?.id ?? null,
        note: parsed.note,
        source: ctx.channel,
        waMessageId: ctx.externalId,
        occurredAt,
      },
    }),
  ];
  if (account) {
    ops.push(prisma.account.update({ where: { id: account.id }, data: { balance: { increment: delta } } }));
  }

  try {
    await prisma.$transaction(ops); // ledger row + running balance, atomically
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.info({ externalId: ctx.externalId }, 'duplicate transaction insert, skipped');
      return;
    }
    throw err;
  }

  const lines = [
    `✅ Dicatat: ${category?.name ?? 'Tanpa kategori'} ${formatIDR(parsed.amount)}` +
      `${account ? ` (${account.name})` : ''} — ${parsed.type === 'INCOME' ? 'pemasukan' : 'pengeluaran'}`,
  ];
  if (parsed.type === 'EXPENSE' && category) {
    lines.push(await remainingBudgetLine(user, category));
  }
  if (!parsed.category) {
    lines.push('Kategori tidak dikenali, kucatat sebagai "Lainnya". Balas "undo" kalau salah.');
  }
  await ctx.reply(lines.join('\n'));
}

async function undoLast(ctx) {
  const user = ctx.user;
  const tx = await prisma.transaction.findFirst({
    where: { userId: user.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { category: true },
  });
  if (!tx) return ctx.reply('Tidak ada transaksi yang bisa dibatalkan.');

  const ops = [prisma.transaction.update({ where: { id: tx.id }, data: { deletedAt: new Date() } })];
  if (tx.type === 'TRANSFER') {
    if (tx.accountId) {
      ops.push(prisma.account.update({ where: { id: tx.accountId }, data: { balance: { increment: tx.amount } } }));
    }
    if (tx.counterAccountId) {
      ops.push(prisma.account.update({ where: { id: tx.counterAccountId }, data: { balance: { decrement: tx.amount } } }));
    }
  } else if (tx.accountId) {
    const delta = tx.type === 'INCOME' ? -tx.amount : tx.amount; // reverse the original effect
    ops.push(prisma.account.update({ where: { id: tx.accountId }, data: { balance: { increment: delta } } }));
  }
  await prisma.$transaction(ops);
  await ctx.reply(`↩️ Dibatalkan: ${tx.category?.name ?? 'transaksi'} ${formatIDR(tx.amount)}`);
}

async function doTransfer(ctx) {
  const user = ctx.user;
  const usage = 'Format: "transfer 500rb bca ke mandiri"';
  const money = extractMoney(ctx.text);
  if (money.error) return ctx.reply(usage);
  const parts = ctx.text.toLowerCase().split(/(?<![a-z0-9])ke(?![a-z0-9])/);
  if (parts.length !== 2) return ctx.reply(usage);
  const from = matchAlias(parts[0], user.accounts)?.item;
  const to = matchAlias(parts[1], user.accounts)?.item;
  if (!from || !to || from.id === to.id) {
    return ctx.reply(`Sebutkan rekening asal dan tujuan yang berbeda. ${usage}`);
  }
  try {
    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: user.id,
          type: 'TRANSFER',
          amount: money.amount,
          accountId: from.id,
          counterAccountId: to.id,
          note: ctx.text,
          source: ctx.channel,
          waMessageId: ctx.externalId,
        },
      }),
      prisma.account.update({ where: { id: from.id }, data: { balance: { decrement: money.amount } } }),
      prisma.account.update({ where: { id: to.id }, data: { balance: { increment: money.amount } } }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
    throw err;
  }
  await ctx.reply(`🔁 Pindah kas ${formatIDR(money.amount)}: ${from.name} → ${to.name}`);
}

// ---------------------------------------------------------------- balance & budget

async function replySaldo(ctx) {
  const accounts = await prisma.account.findMany({
    where: { userId: ctx.user.id },
    orderBy: { createdAt: 'asc' },
  });
  const total = accounts.reduce((sum, a) => sum + a.balance, 0n);
  const lines = accounts.map((a) => `• ${a.name}: ${formatIDR(a.balance)}`);
  await ctx.reply(`💰 Saldo kamu:\n${lines.join('\n')}\nTotal: ${formatIDR(total)}`);
}

function monthKey(date = new Date()) {
  // "YYYY-MM" in Asia/Jakarta regardless of server timezone
  return date.toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 7);
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    start: new Date(`${month}-01T00:00:00+07:00`),
    end: new Date(`${next}-01T00:00:00+07:00`),
  };
}

async function spentThisMonth(userId, categoryId, month = monthKey()) {
  const { start, end } = monthRange(month);
  const agg = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: {
      userId,
      categoryId,
      type: 'EXPENSE',
      deletedAt: null,
      occurredAt: { gte: start, lt: end },
    },
  });
  return agg._sum.amount ?? 0n;
}

async function remainingBudgetLine(user, category) {
  const month = monthKey();
  const [budget, spent] = await Promise.all([
    prisma.budget.findUnique({
      where: { userId_categoryId_month: { userId: user.id, categoryId: category.id, month } },
    }),
    spentThisMonth(user.id, category.id, month),
  ]);
  if (!budget) {
    return `Total ${category.name} bulan ini: ${formatIDR(spent)}. Set budget: "budget ${category.name.toLowerCase()} 2jt"`;
  }
  const remaining = budget.limit - spent;
  return remaining >= 0n
    ? `Sisa budget ${category.name} bulan ini: ${formatIDR(remaining)} dari ${formatIDR(budget.limit)}`
    : `⚠️ Budget ${category.name} terlampaui ${formatIDR(-remaining)} (limit ${formatIDR(budget.limit)})`;
}

async function replyBudgets(ctx) {
  const user = ctx.user;
  const month = monthKey();
  const budgets = await prisma.budget.findMany({
    where: { userId: user.id, month },
    include: { category: true },
  });
  if (budgets.length === 0) {
    return ctx.reply('Belum ada budget bulan ini. Set dengan: "budget makan 2jt"');
  }
  const lines = [];
  for (const b of budgets) {
    const spent = await spentThisMonth(user.id, b.categoryId, month);
    const mark = spent > b.limit ? ' ⚠️' : '';
    lines.push(`• ${b.category.name}: ${formatIDR(spent)} / ${formatIDR(b.limit)}${mark}`);
  }
  await ctx.reply(`📊 Budget ${month}:\n${lines.join('\n')}`);
}

async function setBudget(ctx) {
  const user = ctx.user;
  const rest = ctx.text.slice('budget'.length);
  const money = extractMoney(rest);
  if (money.error) return ctx.reply('Format: "budget makan 2jt"');
  const catMatch = matchAlias(rest, user.categories);
  if (!catMatch) {
    return ctx.reply(`Kategori tidak dikenali. Kategori kamu: ${user.categories.map((c) => c.name).join(', ')}`);
  }
  const month = monthKey();
  await prisma.budget.upsert({
    where: { userId_categoryId_month: { userId: user.id, categoryId: catMatch.item.id, month } },
    create: { userId: user.id, categoryId: catMatch.item.id, month, limit: money.amount },
    update: { limit: money.amount },
  });
  await ctx.reply(`📌 Budget ${catMatch.item.name} bulan ${month}: ${formatIDR(money.amount)}`);
}

// ---------------------------------------------------------------- loans & goals

// Due dates and deadlines are CALENDAR dates, not instants, so they are stored
// at UTC midnight. Storing WIB midnight instead would serialize as the PREVIOUS
// day everywhere outside Asia/Jakarta ("25/8" reading back as Aug 24).
function parseIndoDate(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : new Date().getFullYear();
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates that JS would silently roll over, e.g. "31/2".
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatDateOnly(date) {
  return date.toLocaleDateString('id-ID', { timeZone: 'UTC' });
}

async function createLoan(ctx, direction) {
  const user = ctx.user;
  const rest = ctx.text.replace(/^(utang|piutang)\s+/i, '');
  const dueDate = parseIndoDate(rest, DUE_RE);
  // Strip the date clause first, or its digits ("25/8") would make the
  // amount look ambiguous when the nominal has no rb/jt suffix.
  const cleaned = rest.replace(DUE_RE, ' ').trim();
  const money = extractMoney(cleaned);
  if (money.error) {
    return ctx.reply(`Format: "${direction} Budi 200rb jatuh tempo 25/8"`);
  }
  let name = cleaned.slice(0, money.index).trim();
  if (!name) name = cleaned.slice(money.index + money.raw.length).trim();
  if (!name) name = 'Tanpa nama';

  const loan = await prisma.loan.create({
    data: {
      userId: user.id,
      direction: direction.toUpperCase(), // 'UTANG' | 'PIUTANG'
      counterpartyName: name,
      principal: money.amount,
      remaining: money.amount,
      dueDate,
    },
  });
  const label = loan.direction === 'UTANG' ? `Utang ke ${name}` : `Piutang dari ${name}`;
  const due = dueDate ? `, jatuh tempo ${formatDateOnly(dueDate)}` : '';
  await ctx.reply(`📒 ${label}: ${formatIDR(money.amount)}${due}`);
}

async function createGoal(ctx) {
  const user = ctx.user;
  const rest = ctx.text.replace(/^target\s+/i, '');
  const deadline = parseIndoDate(rest, DATE_RE);
  const cleaned = rest.replace(DATE_RE, ' ').trim();
  const money = extractMoney(cleaned);
  if (money.error) return ctx.reply('Format: "target liburan 5jt tanggal 31/12"');
  let name = cleaned.slice(0, money.index).trim();
  if (!name) name = cleaned.slice(money.index + money.raw.length).trim();
  if (!name) name = 'Target';

  await prisma.goal.create({
    data: { userId: user.id, name, target: money.amount, deadline },
  });
  const due = deadline ? ` sebelum ${formatDateOnly(deadline)}` : '';
  await ctx.reply(`🎯 Target "${name}" ${formatIDR(money.amount)}${due} dibuat. Semangat nabung!`);
}
