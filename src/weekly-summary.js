import cron from 'node-cron';
import pino from 'pino';
import { prisma } from './db.js';
import { sendTemplate, formatIDR } from './whatsapp.js';

const log = pino({ name: 'weekly-summary', level: process.env.LOG_LEVEL || 'info' });
const DAY_MS = 86_400_000;

/*
 * The weekly summary is business-initiated, so it is almost always OUTSIDE the
 * 24h customer-service window and MUST be an approved template.
 *
 * Register in Meta Business Manager (WhatsApp Manager > Message templates):
 *   Name:      weekly_summary
 *   Category:  UTILITY
 *   Language:  Indonesian (id)
 *   Body:
 *     Ringkasan keuangan minggu ini 📊
 *     Pemasukan: {{1}}
 *     Pengeluaran: {{2}}
 *     Pengeluaran terbesar: {{3}}
 *     Progres target: {{4}}
 *   Sample values (required by the review): Rp5.000.000 | Rp3.250.000 |
 *     Konsumsi Rp1.200.000, Transportasi Rp800.000 | Liburan 45%, Umroh 12%
 */

export function startWeeklySummaryJob() {
  cron.schedule(
    '0 18 * * 0', // Sunday 18:00
    () => {
      runWeeklySummary().catch((err) => log.error({ err }, 'weekly summary run failed'));
    },
    { timezone: 'Asia/Jakarta' },
  );
  log.info('weekly summary job scheduled (Sunday 18:00 Asia/Jakarta)');
}

/** Exported separately so it can be triggered manually: node -e "import('./src/weekly-summary.js').then(m => m.runWeeklySummary())" */
export async function runWeeklySummary(now = new Date()) {
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const users = await prisma.user.findMany({ where: { weeklyOptIn: true }, include: { goals: true } });
  log.info({ users: users.length }, 'running weekly summary');
  for (const user of users) {
    try {
      await sendUserSummary(user, weekStart, now);
    } catch (err) {
      log.error({ err, userId: user.id }, 'failed to send weekly summary');
    }
  }
}

async function sendUserSummary(user, from, to) {
  const baseWhere = { userId: user.id, deletedAt: null, occurredAt: { gte: from, lt: to } };

  const [incomeAgg, expenseAgg, topCats] = await Promise.all([
    prisma.transaction.aggregate({ _sum: { amount: true }, where: { ...baseWhere, type: 'INCOME' } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, where: { ...baseWhere, type: 'EXPENSE' } }),
    prisma.transaction.groupBy({
      by: ['categoryId'],
      where: { ...baseWhere, type: 'EXPENSE', categoryId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 3,
    }),
  ]);

  const income = incomeAgg._sum.amount ?? 0n;
  const expense = expenseAgg._sum.amount ?? 0n;
  if (income === 0n && expense === 0n) {
    log.info({ userId: user.id }, 'no activity this week, skipping summary');
    return;
  }

  const catRows = await prisma.category.findMany({
    where: { id: { in: topCats.map((t) => t.categoryId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(catRows.map((c) => [c.id, c.name]));
  const topLine =
    topCats.map((t) => `${nameOf.get(t.categoryId) ?? '?'} ${formatIDR(t._sum.amount ?? 0n)}`).join(', ') || '-';

  const goalLine =
    user.goals
      .map((g) => {
        const pct = g.target > 0n ? Number((g.saved * 100n) / g.target) : 0;
        return `${g.name} ${pct}%`;
      })
      .join(', ') || 'belum ada target';

  await sendTemplate(user.waId, 'weekly_summary', [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: formatIDR(income) },
        { type: 'text', text: formatIDR(expense) },
        { type: 'text', text: topLine },
        { type: 'text', text: goalLine },
      ],
    },
  ]);
  log.info({ userId: user.id }, 'weekly summary sent');
}
