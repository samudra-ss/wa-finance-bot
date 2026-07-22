import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, extractMoney, DEFAULT_CATEGORIES, DEFAULT_ACCOUNTS } from '../src/parser.js';

const parse = (text) => parseMessage(text, DEFAULT_CATEGORIES, DEFAULT_ACCOUNTS);

test('plain amount: "groceries 5000"', () => {
  const p = parse('groceries 5000');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 5000n);
  assert.equal(p.categoryName, 'Kebutuhan Pokok');
  assert.equal(p.type, 'EXPENSE');
});

test('rb suffix: "lunch 50rb"', () => {
  const p = parse('lunch 50rb');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 50_000n);
  assert.equal(p.categoryName, 'Konsumsi');
});

test('income via alias: "gaji 10jt"', () => {
  const p = parse('gaji 10jt');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 10_000_000n);
  assert.equal(p.type, 'INCOME');
  assert.equal(p.categoryName, 'Gaji');
});

test('k suffix: "bensin 25k"', () => {
  const p = parse('bensin 25k');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 25_000n);
  assert.equal(p.categoryName, 'Transportasi');
});

test('ribu suffix, no space: "listrik 150ribu"', () => {
  const p = parse('listrik 150ribu');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 150_000n);
  assert.equal(p.categoryName, 'Utilitas');
});

test('comma decimal with multiplier: "1,5jt makan"', () => {
  const p = parse('1,5jt makan');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 1_500_000n);
  assert.equal(p.categoryName, 'Konsumsi');
});

test('dot decimal with multiplier: "1.5jt makan"', () => {
  const p = parse('1.5jt makan');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 1_500_000n);
});

test('dot thousands grouping: "belanja 10.000"', () => {
  const p = parse('belanja 10.000');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 10_000n);
  assert.equal(p.categoryName, 'Kebutuhan Pokok');
});

test('comma thousands grouping: "makan 10,000"', () => {
  const p = parse('makan 10,000');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 10_000n);
});

test('reversed order: "50rb lunch"', () => {
  const p = parse('50rb lunch');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 50_000n);
  assert.equal(p.categoryName, 'Konsumsi');
});

test('no amount -> NO_AMOUNT', () => {
  const p = parse('makan siang enak banget');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'NO_AMOUNT');
});

test('multiple bare numbers -> AMBIGUOUS_AMOUNT', () => {
  const p = parse('2 kopi 3 donat');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'AMBIGUOUS_AMOUNT');
});

test('decimal rupiah without multiplier is rejected: "makan 1,5"', () => {
  const p = parse('makan 1,5');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'NO_AMOUNT');
});

test('suffixed amount wins over bare quantity: "beli 2 kopi 30rb"', () => {
  const p = parse('beli 2 kopi 30rb');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 30_000n);
  assert.equal(p.categoryName, 'Konsumsi');
});

test('unknown category falls back to Lainnya, expense default', () => {
  const p = parse('asdf 20rb');
  assert.equal(p.ok, true);
  assert.equal(p.category, null);
  assert.equal(p.categoryName, 'Lainnya');
  assert.equal(p.type, 'EXPENSE');
});

test('account alias detected: "makan 50rb bca"', () => {
  const p = parse('makan 50rb bca');
  assert.equal(p.ok, true);
  assert.equal(p.account?.name, 'BCA');
  assert.equal(p.categoryName, 'Konsumsi');
});

test('income alias bonus: "bonus 500rb"', () => {
  const p = parse('bonus 500rb');
  assert.equal(p.ok, true);
  assert.equal(p.type, 'INCOME');
  assert.equal(p.categoryName, 'Bonus');
  assert.equal(p.amount, 500_000n);
});

test('relative date kemarin: "kemarin makan 20rb"', () => {
  const p = parse('kemarin makan 20rb');
  assert.equal(p.ok, true);
  assert.equal(p.dateOffsetDays, -1);
  assert.equal(p.amount, 20_000n);
});

test('multi-group separators: extractMoney("kopi 5.000.000")', () => {
  const m = extractMoney('kopi 5.000.000');
  assert.equal(m.error, undefined);
  assert.equal(m.amount, 5_000_000n);
});

test('Rp prefix: "belanja Rp50.000"', () => {
  const p = parse('belanja Rp50.000');
  assert.equal(p.ok, true);
  assert.equal(p.amount, 50_000n);
});
