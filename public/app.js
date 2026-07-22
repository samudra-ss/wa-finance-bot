// Keuangan Saya — PWA dashboard client.
// Vanilla JS, no build step, no external dependencies (must run under a strict
// CSP and fully offline once cached). Talks to /api/* (see src/api.js).

const TOKEN_KEY = 'kw_token';
const CACHE_KEY = 'kw_dashboard_cache';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  dashboard: null,
  view: 'dashboard',
  txType: '',
  txOffset: 0,
  txItems: [],
  loanDir: 'PIUTANG',
};

// ---------------------------------------------------------------- fetch helper

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error('Sesi berakhir, silakan login lagi.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- formatting

function idr(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}Rp${Math.abs(n).toLocaleString('id-ID')}`;
}

function idrShort(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${n < 0 ? '-' : ''}Rp${(abs / 1_000_000_000).toFixed(1)}M`;
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}Rp${(abs / 1_000_000).toFixed(1)}jt`;
  if (abs >= 1_000) return `${n < 0 ? '-' : ''}Rp${(abs / 1_000).toFixed(0)}rb`;
  return idr(n);
}

function relTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((now - d) / 86_400_000);
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  if (days === 0) return `Hari ini, ${time}`;
  if (days === 1) return `Kemarin, ${time}`;
  if (days < 7) return d.toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' }) + `, ${time}`;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
}

function dateOnly(iso) {
  if (!iso) return null;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00Z`);
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - todayUtc) / 86_400_000);
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------- auth

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(CACHE_KEY);
  showLogin();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const btn = $('#login-btn');
  const errEl = $('#login-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Memeriksa...';
  try {
    const phone = $('#phone').value;
    const code = $('#code').value;
    const body = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ phone, code }) });
    state.token = body.token;
    localStorage.setItem(TOKEN_KEY, body.token);
    $('#login').classList.add('hidden');
    showApp();
    await loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Masuk';
  }
}

// One-tap login: the bot sends a link like /?id=<identity>&code=<code>. If those
// params are present, log in automatically and scrub them from the URL.
async function tryMagicLogin() {
  const p = new URLSearchParams(location.search);
  const identity = p.get('id');
  const code = p.get('code');
  if (!identity || !code) return false;
  try {
    const body = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ identity, code }) });
    state.token = body.token;
    localStorage.setItem(TOKEN_KEY, body.token);
    history.replaceState(null, '', location.pathname); // don't leave the code in the address bar
    showApp();
    await loadDashboard();
    return true;
  } catch (err) {
    history.replaceState(null, '', location.pathname);
    const errEl = $('#login-error');
    if (errEl) errEl.textContent = err.message;
    return false;
  }
}

// ---------------------------------------------------------------- dashboard render

function renderHero(d) {
  $('#net-worth').textContent = idr(d.netWorth);
  $('#cash').textContent = idr(d.cash);
  $('#piutang').textContent = idr(d.piutang);
  $('#utang').textContent = idr(d.utang);
  $('#income').textContent = idr(d.monthlyIncome);
  $('#expense').textContent = idr(d.monthlyExpense);

  const lvl = d.level;
  $('#level-badge').innerHTML = `${lvl.emoji} Level ${lvl.level} — ${lvl.label}<small>${lvl.note}</small>`;
}

const PALETTE = ['#0f766e', '#f59e0b', '#6366f1', '#ec4899', '#0891b2', '#84cc16', '#a855f7', '#64748b'];

function renderDonut(spending) {
  const wrap = $('#donut-wrap');
  const list = $('#category-list');
  list.innerHTML = '';

  if (!spending.length) {
    wrap.innerHTML = '<p class="empty">Belum ada pengeluaran bulan ini.</p>';
    return;
  }

  const total = spending.reduce((s, c) => s + c.amount, 0);
  const R = 60;
  const CIRC = 2 * Math.PI * R;
  let offset = 0;
  const segs = spending
    .slice(0, 8)
    .map((c, i) => {
      const frac = total > 0 ? c.amount / total : 0;
      const len = frac * CIRC;
      const seg = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${PALETTE[i % PALETTE.length]}"
        stroke-width="20" stroke-dasharray="${len} ${CIRC - len}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 80 80)" stroke-linecap="butt" />`;
      offset += len;
      return seg;
    })
    .join('');

  wrap.innerHTML = `
    <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="Pengeluaran per kategori">
      ${segs}
      <text x="80" y="76" text-anchor="middle" font-size="12" fill="var(--muted)">Total</text>
      <text x="80" y="94" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${idrShort(total)}</text>
    </svg>`;

  list.innerHTML = spending
    .slice(0, 8)
    .map((c, i) => {
      const pct = total > 0 ? Math.round((c.amount / total) * 100) : 0;
      return `<li>
        <span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="cat-name">${escapeHtml(c.name)}</span>
        <span class="cat-amt">${idr(c.amount)}</span>
        <span class="cat-pct">${pct}%</span>
      </li>`;
    })
    .join('');
}

function renderAccounts(accounts) {
  const el = $('#account-list');
  if (!accounts.length) {
    el.innerHTML = '<li class="empty">Belum ada rekening.</li>';
    return;
  }
  el.innerHTML = accounts
    .map(
      (a) => `<li>
        <div class="row-main"><div class="row-title">${escapeHtml(a.name)}</div></div>
        <div class="row-amt ${a.balance < 0 ? 'neg' : ''}">${idr(a.balance)}</div>
      </li>`,
    )
    .join('');
}

function txRow(t) {
  const sign = t.type === 'INCOME' ? '+' : t.type === 'EXPENSE' ? '-' : '';
  const cls = t.type === 'INCOME' ? 'pos' : t.type === 'EXPENSE' ? 'neg' : '';
  const label = t.category || (t.type === 'TRANSFER' ? 'Pindah kas' : 'Lainnya');
  const sub = [t.account, relTime(t.occurredAt)].filter(Boolean).join(' · ');
  const badge =
    t.source === 'WHATSAPP'
      ? '<span class="wa-tag">WA</span>'
      : t.source === 'TELEGRAM'
        ? '<span class="wa-tag">TG</span>'
        : '';
  return `<li>
    <div class="row-main">
      <div class="row-title">${escapeHtml(label)}${badge}</div>
      <div class="row-sub">${escapeHtml(sub)}</div>
    </div>
    <div class="row-amt ${cls}">${sign}${idr(t.amount)}</div>
  </li>`;
}

function renderRecent(recent) {
  const el = $('#recent-list');
  el.innerHTML = recent.length ? recent.map(txRow).join('') : '<li class="empty">Belum ada transaksi.</li>';
}

function renderDashboard(d) {
  renderHero(d);
  renderDonut(d.spending);
  renderAccounts(d.accounts);
  renderRecent(d.recent);
}

// ---------------------------------------------------------------- transactions view

function renderTxList(replace) {
  const el = $('#tx-list');
  const html = state.txItems.map(txRow).join('');
  el.innerHTML = state.txItems.length ? html : '<li class="empty">Tidak ada transaksi.</li>';
  $('#tx-more').classList.toggle('hidden', state.txItems.length >= state.txTotal);
}

async function loadTransactions(reset) {
  if (reset) {
    state.txOffset = 0;
    state.txItems = [];
  }
  const q = new URLSearchParams({ limit: '20', offset: String(state.txOffset) });
  if (state.txType) q.set('type', state.txType);
  const body = await api(`/transactions?${q}`);
  state.txItems = reset ? body.items : [...state.txItems, ...body.items];
  state.txTotal = body.total;
  state.txOffset = state.txItems.length;
  renderTxList();
}

// ---------------------------------------------------------------- loans view

function renderLoans() {
  const list = state.dashboard.loans.filter((l) => l.direction === state.loanDir);
  const el = $('#loan-list');
  if (!list.length) {
    el.innerHTML = `<div class="card empty">${state.loanDir === 'PIUTANG' ? 'Belum ada piutang tercatat.' : 'Belum ada utang tercatat.'}</div>`;
    return;
  }
  el.innerHTML = list
    .map((l) => {
      const dleft = daysUntil(l.dueDate);
      let dueCls = '';
      let dueLabel = 'Tanpa tenggat';
      if (dleft !== null) {
        dueLabel = dateOnly(l.dueDate);
        if (dleft < 0) { dueCls = 'over'; dueLabel = `Lewat ${Math.abs(dleft)} hari`; }
        else if (dleft <= 7) { dueCls = 'soon'; dueLabel = dleft === 0 ? 'Hari ini' : `${dleft} hari lagi`; }
      }
      const reminderBtn =
        state.loanDir === 'PIUTANG' && l.phone
          ? `<a class="wa-btn" target="_blank" rel="noopener"
              href="https://wa.me/${l.phone.replace(/\D/g, '')}?text=${encodeURIComponent(
                `Halo ${l.name}, mengingatkan piutang ${idr(l.remaining)} ya. Terima kasih 🙏`,
              )}">Kirim pengingat WA</a>`
          : state.loanDir === 'PIUTANG'
            ? '<p class="muted small">Tambahkan nomor WA lewat bot untuk kirim pengingat.</p>'
            : '';
      return `<div class="card loan-card">
        <div class="loan-head">
          <div>
            <div class="row-title">${escapeHtml(l.name)}</div>
            <div class="row-sub">Sisa ${idr(l.remaining)} dari ${idr(l.principal)}</div>
          </div>
          <span class="due ${dueCls}">${dueLabel}</span>
        </div>
        ${reminderBtn}
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- goals view

function renderGoals() {
  const el = $('#goal-list');
  const goals = state.dashboard.goals;
  if (!goals.length) {
    el.innerHTML = '<div class="card empty">Belum ada target. Kirim "target liburan 5jt tanggal 31/12" ke bot.</div>';
    return;
  }
  el.innerHTML = goals
    .map((g) => {
      const barCls = g.pct >= 100 ? '' : '';
      let proj = 'Belum ada proyeksi — mulai menabung rutin dulu.';
      if (g.pct >= 100) proj = '🎉 Target tercapai!';
      else if (g.projection) proj = `Diperkirakan selesai ${dateOnly(g.projection.date)} (${g.projection.months} bln lagi)`;
      return `<div class="card">
        <div class="goal-card">
          <div class="goal-info">
            <div class="goal-name">${escapeHtml(g.name)}</div>
            <div class="row-sub">${idr(g.saved)} / ${idr(g.target)} · ${g.pct}%</div>
            <div class="bar"><i class="${barCls}" style="width:${g.pct}%"></i></div>
          </div>
        </div>
        <p class="row-sub" style="margin-top:10px">${proj}</p>
        ${g.deadline ? `<p class="row-sub">Target tanggal: ${dateOnly(g.deadline)}</p>` : ''}
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- advisor view

function renderGauge(health) {
  const wrap = $('#gauge-wrap');
  const score = health.score;
  const R = 70;
  const CIRC = Math.PI * R; // semicircle
  const frac = score / 100;
  const color = score >= 70 ? 'var(--pos)' : score >= 40 ? 'var(--warn)' : 'var(--neg)';
  wrap.innerHTML = `
    <svg width="180" height="100" viewBox="0 0 180 100">
      <path d="M 10 90 A ${R} ${R} 0 0 1 170 90" fill="none" stroke="var(--line)" stroke-width="16" stroke-linecap="round" />
      <path d="M 10 90 A ${R} ${R} 0 0 1 170 90" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"
        stroke-dasharray="${CIRC * frac} ${CIRC}" />
      <text x="90" y="72" text-anchor="middle" font-size="26" font-weight="800" fill="var(--text)">${score}</text>
      <text x="90" y="90" text-anchor="middle" font-size="11" fill="var(--muted)">dari 100</text>
    </svg>`;
}

function renderChecks(health) {
  $('#check-list').innerHTML = health.checks
    .map(
      (c) => `<li>
        <span class="mark ${c.pass ? 'ok' : 'no'}">${c.pass ? '✓' : '○'}</span>
        <span>${escapeHtml(c.label)}</span>
      </li>`,
    )
    .join('');
}

function renderBudgets(budgets) {
  const el = $('#budget-list');
  if (!budgets.length) {
    el.innerHTML = '<p class="empty">Belum ada budget. Kirim "budget makan 2jt" ke bot.</p>';
    return;
  }
  el.innerHTML = budgets
    .map((b) => {
      const pct = b.limit > 0 ? Math.min(100, Math.round((b.spent / b.limit) * 100)) : 0;
      const over = b.remaining < 0;
      return `<div style="margin-bottom:14px">
        <div class="row-sub" style="display:flex;justify-content:space-between;margin-bottom:5px">
          <span>${escapeHtml(b.category)}</span>
          <span class="${over ? 'neg' : ''}">${idr(b.spent)} / ${idr(b.limit)}</span>
        </div>
        <div class="bar"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></div>
      </div>`;
    })
    .join('');
}

function ruleBasedTips(d) {
  const tips = [];
  const h = d.health;
  if (h.emergencyMonths !== null && h.emergencyMonths < 3) {
    tips.push('Dana darurat kamu masih di bawah 3 bulan pengeluaran. Prioritaskan menabung ke rekening darurat sebelum target lain.');
  }
  if (d.monthlyExpense > 0 && d.avgMonthlyExpense > 0 && d.monthlyExpense > d.avgMonthlyExpense * 1.2) {
    const pct = Math.round((d.monthlyExpense / d.avgMonthlyExpense - 1) * 100);
    tips.push(`Pengeluaran bulan ini ${pct}% lebih tinggi dari rata-rata 3 bulan terakhir. Cek kategori terbesar di tab Ringkasan.`);
  }
  if (h.monthsToClearDebt !== null && h.monthsToClearDebt > 12) {
    tips.push('Dengan tabungan saat ini, utang akan lunas lebih dari 12 bulan. Coba naikkan porsi bayar utang di budget bulanan.');
  }
  const goalBehind = d.goals.find((g) => g.pct < 100 && !g.projection);
  if (goalBehind) {
    tips.push(`Target "${goalBehind.name}" belum ada proyeksi selesai karena belum ada tabungan bulan ini — mulai rutin menabung ke rekeningnya.`);
  }
  if (d.monthlySavings > 0 && h.savingRate > 0.3) {
    tips.push(`Kerja bagus! Kamu menabung ${Math.round(h.savingRate * 100)}% dari pemasukan bulan ini.`);
  }
  if (!tips.length) tips.push('Belum ada catatan khusus bulan ini. Terus catat transaksi lewat WhatsApp agar saran makin akurat.');
  return tips;
}

function renderAdvisor(d) {
  renderGauge(d.health);
  renderChecks(d.health);
  renderBudgets(d.budgets);
  $('#tips-list').innerHTML = ruleBasedTips(d)
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');
}

// ---------------------------------------------------------------- render-all + nav

function renderAll(d) {
  state.dashboard = d;
  renderDashboard(d);
  renderLoans();
  renderGoals();
  renderAdvisor(d);
  $('#greeting').textContent = `Halo${d.userName ? ', ' + d.userName : ''} 👋`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  const titles = { dashboard: 'Ringkasan', transactions: 'Transaksi', loans: 'Utang & Piutang', goals: 'Target', advisor: 'Saran' };
  $('#page-title').textContent = titles[view] || '';
  if (view === 'transactions' && !state.txItems.length) loadTransactions(true).catch((e) => toast(e.message));
  window.scrollTo(0, 0);
}

async function loadDashboard() {
  try {
    const d = await api('/dashboard');
    const me = await api('/me').catch(() => null);
    if (me) d.userName = me.name;
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(d));
    renderAll(d);
  } catch (err) {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      renderAll(JSON.parse(cached));
      toast('Offline — menampilkan data terakhir.');
    } else {
      toast(err.message);
    }
  }
}

async function refresh() {
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    await loadDashboard();
    if (state.view === 'transactions') await loadTransactions(true);
  } finally {
    btn.classList.remove('spin');
  }
}

// ---------------------------------------------------------------- wiring

function init() {
  $('#login-form').addEventListener('submit', handleLoginSubmit);
  $('#refresh').addEventListener('click', refresh);

  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)));

  $$('#tx-filters .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#tx-filters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.txType = chip.dataset.type;
      loadTransactions(true).catch((e) => toast(e.message));
    }),
  );
  $('#tx-more').addEventListener('click', () => loadTransactions(false).catch((e) => toast(e.message)));

  $$('#loan-tabs .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      $$('#loan-tabs .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.loanDir = chip.dataset.dir;
      renderLoans();
    }),
  );

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  if (params.get('id') && params.get('code')) {
    showLogin(); // shown briefly; replaced by the app on success
    tryMagicLogin().then((ok) => {
      if (!ok && !state.token) showLogin();
    });
    return;
  }

  const cached = sessionStorage.getItem(CACHE_KEY);
  if (state.token) {
    if (cached) renderAll(JSON.parse(cached));
    showApp();
    loadDashboard();
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);
