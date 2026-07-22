// Deterministic Indonesian transaction parser — Tier 0/1 of the NLP pipeline.
// Pure functions only (no I/O, no DB) so it is trivially unit-testable.
// All amounts are BigInt rupiah: IDR has no usable subunit, integers are exact.

export const DEFAULT_CATEGORIES = [
  { name: 'Gaji', kind: 'INCOME', aliases: ['gaji', 'gajian', 'salary'] },
  { name: 'Proyek', kind: 'INCOME', aliases: ['proyek', 'project', 'freelance', 'fee'] },
  { name: 'Dividen', kind: 'INCOME', aliases: ['dividen', 'dividend'] },
  { name: 'Bonus', kind: 'INCOME', aliases: ['bonus', 'thr'] },
  {
    name: 'Konsumsi',
    kind: 'EXPENSE',
    aliases: ['makan', 'makan siang', 'makan malam', 'sarapan', 'lunch', 'dinner', 'breakfast', 'kopi', 'coffee', 'jajan', 'snack', 'gofood', 'grabfood'],
  },
  {
    name: 'Kebutuhan Pokok',
    kind: 'EXPENSE',
    aliases: ['groceries', 'belanja', 'warung', 'pasar', 'supermarket', 'indomaret', 'alfamart', 'beras', 'sembako'],
  },
  {
    name: 'Transportasi',
    kind: 'EXPENSE',
    aliases: ['bensin', 'pertalite', 'gojek', 'grab', 'ojol', 'parkir', 'tol', 'busway', 'krl', 'mrt', 'taksi', 'transport'],
  },
  {
    name: 'Utilitas',
    kind: 'EXPENSE',
    aliases: ['listrik', 'pln', 'pulsa', 'internet', 'wifi', 'air', 'pdam', 'token listrik'],
  },
  { name: 'Kesehatan', kind: 'EXPENSE', aliases: ['obat', 'dokter', 'apotek', 'rumah sakit', 'bpjs'] },
  { name: 'Hiburan', kind: 'EXPENSE', aliases: ['nonton', 'bioskop', 'netflix', 'spotify', 'game', 'hiburan'] },
  { name: 'Lainnya', kind: 'EXPENSE', aliases: [] },
];

export const DEFAULT_ACCOUNTS = [
  { name: 'Uang Tunai', aliases: ['tunai', 'cash'], isDefault: true },
  { name: 'BCA', aliases: ['bca'] },
  { name: 'Mandiri', aliases: ['mandiri'] },
  { name: 'BRI', aliases: ['bri'] },
];

export const HELP_TEXT = [
  'Format pesan yang aku mengerti:',
  '• Pengeluaran: "makan siang 50rb", "bensin 25k", "belanja 100.000"',
  '• Pemasukan: "gaji 10jt", "bonus 500rb"',
  '• Saldo: ketik "saldo"',
  '• Budget: "budget" (lihat) atau "budget makan 2jt" (set)',
  '• Pindah kas: "transfer 500rb bca ke mandiri"',
  '• Utang: "utang Budi 200rb jatuh tempo 25/8"',
  '• Piutang: "piutang Sari 500rb"',
  '• Target nabung: "target liburan 5jt tanggal 31/12"',
  '• Batalkan transaksi terakhir: "undo"',
  '• Buka dashboard: ketik "login"',
].join('\n');

const MULTIPLIERS = {
  rb: 1_000n,
  ribu: 1_000n,
  k: 1_000n,
  jt: 1_000_000n,
  juta: 1_000_000n,
  m: 1_000_000_000n, // "1m" = 1 milyar in Indonesian money shorthand
};

// number + optional Indonesian multiplier. Matches: "5000", "10.000", "10,000",
// "50rb", "150ribu", "25k", "10jt", "1,5jt", "1.5jt", "Rp50.000".
const MONEY_RE = /(?<![\w.,])(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta|m)?\b/gi;

// Decide whether [.,] inside a numeric token is a thousands separator or a
// decimal separator. Returns { int, frac } (strings) or null when malformed.
function splitNumber(numStr) {
  const parts = numStr.split(/[.,]/);
  if (parts.length === 1) return { int: parts[0], frac: null };
  // "10.000", "10,000", "5.000.000": every group after the first is exactly 3 digits.
  if (parts.slice(1).every((p) => p.length === 3)) return { int: parts.join(''), frac: null };
  // "1,5" / "1.5": a single separator followed by 1-2 digits is a decimal.
  if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) {
    return { int: parts[0], frac: parts[1] };
  }
  return null; // e.g. "1.234,56" — unsupported, treat as not-a-money-token
}

// -> BigInt rupiah, or null when the token cannot be an IDR amount.
function tokenToIDR(numStr, suffix) {
  const s = splitNumber(numStr);
  if (!s) return null;
  const mult = suffix ? MULTIPLIERS[suffix.toLowerCase()] : 1n;
  let amount = BigInt(s.int) * mult;
  if (s.frac) {
    // "1,5" only makes sense with a multiplier (1,5jt). Decimal rupiah do not exist.
    if (!suffix) return null;
    const scale = 10n ** BigInt(s.frac.length);
    if (mult % scale !== 0n) return null;
    amount += BigInt(s.frac) * (mult / scale);
  }
  return amount > 0n ? amount : null;
}

function chooseCandidate(cands) {
  if (cands.length === 1) return cands[0];
  const suffixed = cands.filter((c) => c.hasSuffix);
  if (suffixed.length === 1) return suffixed[0]; // "beli 2 kopi 30rb" -> 30rb
  if (suffixed.length > 1) return null;
  const formatted = cands.filter((c) => c.hasSeparator);
  if (formatted.length === 1) return formatted[0]; // "beli 2 kopi 10.000" -> 10.000
  return null;
}

/**
 * Find the money token in a message.
 * @returns {{amount: bigint, raw: string, index: number} | {error: 'NO_AMOUNT'|'AMBIGUOUS_AMOUNT'}}
 */
export function extractMoney(text) {
  const candidates = [];
  for (const m of (text ?? '').matchAll(MONEY_RE)) {
    const [raw, num, suffix] = m;
    const amount = tokenToIDR(num, suffix);
    if (amount === null) continue;
    candidates.push({
      amount,
      raw,
      index: m.index,
      hasSuffix: Boolean(suffix),
      hasSeparator: /[.,]/.test(num),
    });
  }
  if (candidates.length === 0) return { error: 'NO_AMOUNT' };
  const chosen = chooseCandidate(candidates);
  if (!chosen) return { error: 'AMBIGUOUS_AMOUNT' };
  return { amount: chosen.amount, raw: chosen.raw, index: chosen.index };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Longest-alias match against a list of { name, aliases } items
 * (works for both Category and Account rows).
 * @returns {{item: object, alias: string} | null}
 */
export function matchAlias(text, items) {
  const haystack = ` ${(text ?? '').toLowerCase()} `;
  let best = null;
  for (const item of items) {
    for (const candidate of [item.name, ...(item.aliases ?? [])]) {
      const needle = String(candidate ?? '').toLowerCase().trim();
      if (!needle) continue;
      const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`);
      if (re.test(haystack) && (!best || needle.length > best.needle.length)) {
        best = { item, alias: candidate, needle };
      }
    }
  }
  return best ? { item: best.item, alias: best.alias } : null;
}

/**
 * Parse a free-text WhatsApp message into a transaction draft.
 * Categories/accounts default to the built-in tables but callers should pass
 * the user's own rows (which layer per-user aliases over the defaults).
 *
 * @returns {{ok: false, reason: 'NO_AMOUNT'|'AMBIGUOUS_AMOUNT'} |
 *           {ok: true, amount: bigint, type: 'INCOME'|'EXPENSE', category: object|null,
 *            categoryName: string, account: object|null, dateOffsetDays: number, note: string}}
 */
export function parseMessage(text, categories = DEFAULT_CATEGORIES, accounts = DEFAULT_ACCOUNTS) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'NO_AMOUNT' };

  const money = extractMoney(trimmed);
  if (money.error) return { ok: false, reason: money.error };

  // Everything except the money token is the category/account phrase.
  const rest = (trimmed.slice(0, money.index) + ' ' + trimmed.slice(money.index + money.raw.length)).toLowerCase();

  const dateOffsetDays = /(?<![a-z0-9])kemarin(?![a-z0-9])/.test(rest) ? -1 : 0;
  const catMatch = matchAlias(rest, categories);
  const accMatch = matchAlias(rest, accounts);
  const category = catMatch?.item ?? null;

  return {
    ok: true,
    amount: money.amount,
    type: category?.kind === 'INCOME' ? 'INCOME' : 'EXPENSE', // expense is the default
    category,
    categoryName: category?.name ?? 'Lainnya',
    account: accMatch?.item ?? null,
    dateOffsetDays,
    note: trimmed,
  };
}
