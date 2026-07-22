// Financial health calculations, ported from the "Finesse Wealth Checker"
// Excel template (sheets: Level Kekayaan, Cek Kesehatan Finansial).
//
// Pure functions over plain numbers so they can be unit-tested without a DB.
// Callers convert BigInt rupiah to Number first — IDR amounts stay far below
// Number.MAX_SAFE_INTEGER (9e15 rupiah ~ Rp9 quadrillion).

/**
 * The 8 checks from "Cek Kesehatan Finansial". Score is passed/8 as a percentage.
 * @param {object} f
 * @param {number} f.netWorth        assets - debts
 * @param {number} f.monthlyIncome   income this month
 * @param {number} f.monthlyExpense  expenses this month
 * @param {number} f.cash            total across all accounts
 * @param {number} f.totalDebt       outstanding utang
 * @param {number} f.avgMonthlyExpense trailing average, falls back to this month
 */
export function healthCheck(f) {
  const savings = f.monthlyIncome - f.monthlyExpense;
  const savingRate = f.monthlyIncome > 0 ? savings / f.monthlyIncome : 0;
  const burn = f.avgMonthlyExpense > 0 ? f.avgMonthlyExpense : f.monthlyExpense;
  const emergencyMonths = burn > 0 ? f.cash / burn : f.cash > 0 ? Infinity : 0;
  const monthsToClearDebt = savings > 0 ? f.totalDebt / savings : f.totalDebt > 0 ? Infinity : 0;

  const checks = [
    { key: 'net_worth_positive', label: 'Kekayaan bersih positif', pass: f.netWorth > 0 },
    { key: 'income_covers_expense', label: 'Pemasukan menutup pengeluaran', pass: savings > 0 },
    { key: 'save_10', label: 'Bisa menabung >10% pemasukan', pass: savingRate > 0.1 },
    { key: 'save_30', label: 'Bisa menabung >30% pemasukan', pass: savingRate > 0.3 },
    { key: 'debt_clearable', label: 'Utang lunas dalam 12 bulan menabung', pass: monthsToClearDebt <= 12 },
    { key: 'emergency_1', label: 'Dana darurat 1x pengeluaran bulanan', pass: emergencyMonths >= 1 },
    { key: 'emergency_3', label: 'Dana darurat 3x pengeluaran bulanan', pass: emergencyMonths >= 3 },
    { key: 'emergency_6', label: 'Dana darurat 6x pengeluaran bulanan', pass: emergencyMonths >= 6 },
  ];

  const passed = checks.filter((c) => c.pass).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    passed,
    total: checks.length,
    checks,
    savingRate,
    emergencyMonths: Number.isFinite(emergencyMonths) ? emergencyMonths : null,
    monthsToClearDebt: Number.isFinite(monthsToClearDebt) ? monthsToClearDebt : null,
  };
}

const LEVELS = [
  { level: 0, label: 'Pailit', emoji: '💥', note: 'Aset lebih kecil dari utang.' },
  { level: 1, label: 'Terjerat utang', emoji: '🚨', note: 'Utang masih lebih besar dari kekayaan.' },
  { level: 2, label: 'Terlihat kaya', emoji: '💅', note: 'Uang tunai lebih kecil dari utang.' },
  { level: 3, label: 'Gaji ke gaji', emoji: '🔁', note: 'Belum punya dana darurat 1 bulan.' },
  { level: 4, label: 'Punya dana darurat', emoji: '🛟', note: 'Dana darurat minimal 6 bulan pengeluaran.' },
  { level: 5, label: 'Dana pensiun', emoji: '🌅', note: 'Aset cukup untuk biaya hidup sampai pensiun.' },
  { level: 6, label: 'Punya warisan', emoji: '👑', note: 'Aset melebihi kebutuhan seumur hidup.' },
];

/**
 * "Level Kekayaan" ladder 0-6. Each level is a strictly harder gate than the
 * one before, evaluated top-down.
 */
export function wealthLevel(f) {
  const burn = f.avgMonthlyExpense > 0 ? f.avgMonthlyExpense : f.monthlyExpense;
  const emergencyMonths = burn > 0 ? f.cash / burn : f.cash > 0 ? Infinity : 0;
  // Years of expenses covered by everything you own.
  const yearsCovered = burn > 0 ? f.netWorth / (burn * 12) : f.netWorth > 0 ? Infinity : 0;

  let level;
  if (f.netWorth < 0) level = 0;
  else if (f.totalDebt > f.netWorth) level = 1;
  else if (f.totalDebt > f.cash) level = 2;
  else if (emergencyMonths < 1) level = 3;
  else if (yearsCovered < 15) level = 4; // has emergency fund, not yet pension-proof
  else if (yearsCovered < 30) level = 5; // covers retirement
  else level = 6; // enough to leave an inheritance

  return { ...LEVELS[level], emergencyMonths: Number.isFinite(emergencyMonths) ? emergencyMonths : null };
}

/** Default "Saran Budgeting" split from the Excel, as fractions of income. */
export const BUDGET_SPLIT = [
  { category: 'Kebutuhan Pokok', pct: 0.5 },
  { category: 'Beli Barang', pct: 0.1 },
  { category: 'Beli Aset', pct: 0.1 },
  { category: 'Bayar Utang', pct: 0.1 },
  { category: 'Tabungan', pct: 0.2 },
];

/**
 * Projected completion date for a savings goal at the current savings rate.
 * @returns {{months: number, date: string} | null} null when it will never finish
 */
export function goalProjection(saved, target, monthlySavings, from = new Date()) {
  const remaining = target - saved;
  if (remaining <= 0) return { months: 0, date: from.toISOString().slice(0, 10) };
  if (!(monthlySavings > 0)) return null;
  const months = Math.ceil(remaining / monthlySavings);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  return { months, date: d.toISOString().slice(0, 10) };
}
