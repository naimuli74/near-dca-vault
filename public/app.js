(function () {
  const $ = (id) => document.getElementById(id);
  const fmtUsd = (n) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const fmtAmt = (n, d = 6) => {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const x = Number(n);
    if (x !== 0 && Math.abs(x) < 1 / 10 ** Math.max(0, d - 2)) return x.toFixed(Math.min(8, d + 2)).replace(/0+$/, '').replace(/\.$/, '');
    return x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  };
  const short = (s) => !s ? '—' : s.length > 18 ? s.slice(0, 8) + '…' + s.slice(-6) : s;
  const badgeClass = (k) => {
    if (k === 'DRY_QUOTED' || k === 'SUCCESS') return 'ok';
    if (k === 'SKIPPED_SLIPPAGE' || k === 'REFUNDED' || k === 'FAILED' || k === 'INCOMPLETE_DEPOSIT') return 'bad';
    if (k === 'PENDING_DEPOSIT' || k === 'KNOWN_DEPOSIT_TX' || k === 'PROCESSING') return 'wait';
    return '';
  };

  const CHAIN_NAMES = {
    eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR',
    op: 'Optimism', pol: 'Polygon', avax: 'Avalanche', gnosis: 'Gnosis', bsc: 'BNB Chain',
    aptos: 'Aptos', sui: 'Sui', stellar: 'Stellar', monad: 'Monad', xlayer: 'X Layer',
    hypercore: 'Hypercore',
  };
  const chainName = (id) => CHAIN_NAMES[id] || String(id || '').toUpperCase();

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    const m = $('themecolor');
    if (m) m.content = t === 'dark' ? '#0b0e0d' : '#f3f0e8';
    try { localStorage.setItem('theme', t); } catch {}
  }
  $('themetog')?.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  let tokens = { usdc: [], targets: {} };
  let mode = 'dry';
  let countdownTimer = null;
  let pollTimer = null;

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({ message: res.statusText }));
    if (!res.ok || data.ok === false) throw new Error(data.message || 'Request failed');
    return data;
  }

  function originChain() {
    const asset = tokens.usdc.find(t => t.assetId === $('origin').value);
    return asset ? asset.blockchain : 'eth';
  }
  function targetChain() {
    const t = ($('target').value || 'BTC').toUpperCase();
    return t === 'BTC' ? 'btc' : t === 'NEAR' ? 'near' : 'eth';
  }
  function updateHints() {
    const t = targetChain();
    const oc = originChain();
    const dest = t === 'btc' ? 'a Bitcoin address (bc1…, 1… or 3…)' : t === 'near' ? 'a NEAR account (name.near)' : 'an 0x address on Ethereum';
    if ($('recipient-hint')) $('recipient-hint').textContent = `Send the bought asset to ${dest}.`;
    if ($('refund')) $('refund').placeholder = oc === 'near' ? 'your-account.near' : oc === 'sol' ? 'Your Solana address' : '0x… on ' + oc;
    if ($('recipient')) $('recipient').placeholder = t === 'btc' ? 'bc1…' : t === 'near' ? 'your-account.near' : '0x…';
  }

  function setMode(next) {
    mode = next === 'live' ? 'live' : 'dry';
    $('mode-dry').classList.toggle('on', mode === 'dry');
    $('mode-live').classList.toggle('on', mode === 'live');
    $('live-box').classList.toggle('show', mode === 'live');
    $('mode-hint').textContent = mode === 'dry'
      ? 'Dry-run fetches real quotes and writes them to history. Nothing is deposited.'
      : 'Live mode issues a real mainnet deposit address when you buy. You send the funds yourself.';
  }
  $('mode-dry')?.addEventListener('click', () => setMode('dry'));
  $('mode-live')?.addEventListener('click', () => setMode('live'));
  $('origin')?.addEventListener('change', updateHints);
  $('target')?.addEventListener('change', updateHints);

  function formBody() {
    return {
      mode,
      originAsset: $('origin').value,
      target: $('target').value,
      amountHuman: $('amount').value.trim(),
      interval: $('interval').value,
      recipient: $('recipient').value.trim(),
      refundTo: $('refund').value.trim(),
      slippageBps: Number($('slippage').value),
      maxBuys: $('maxbuys').value === '' ? null : Number($('maxbuys').value),
    };
  }

  function renderFeeBox(analysis, quote) {
    if (!analysis) return '<p class="muted">No quote.</p>';
    const q = quote?.quote || {};
    const rejected = analysis.rejected ? `<p class="err">${esc(analysis.reason)}</p>` : `<p class="okmsg">Within your ${analysis.slippageLimitBps} bps limit after known fees.</p>`;
    return `
      <div class="fee">
        <div><span>You send</span><b>${fmtAmt(analysis.amountIn, 6)} ${esc(analysis.originSymbol)} (${fmtUsd(analysis.amountInUsd)})</b></div>
        <div><span>You would receive</span><b>${fmtAmt(analysis.amountOut, 8)} ${esc(analysis.destSymbol)} (${fmtUsd(analysis.amountOutUsd)})</b></div>
        <div><span>Minimum out</span><b>${fmtAmt(analysis.minAmountOut, 8)} ${esc(analysis.destSymbol)}</b></div>
        <div><span>Withdraw fee</span><b>${fmtAmt(analysis.withdrawFee, 8)} ${esc(analysis.destSymbol)} (${fmtUsd(analysis.withdrawFeeUsd)})</b></div>
        <div><span>Refund fee (if it fails)</span><b>${fmtAmt(analysis.refundFee, 6)} ${esc(analysis.originSymbol)}</b></div>
        <div><span>1Click / app fee</span><b>${fmtAmt(analysis.appFeeBps, 0)} bps (${fmtUsd(analysis.appFeeUsd)})</b></div>
        <div><span>Gross gap</span><b>${fmtAmt(analysis.grossBps, 0)} bps</b></div>
        <div><span>Price slippage after fees</span><b>${fmtAmt(analysis.priceSlippageBps, 0)} bps</b></div>
      </div>
      <p class="hint">Fixed withdraw fees are large on small sizes. Estimated time ${q.timeEstimate ? Math.round(q.timeEstimate / 60) + ' min' : 'n/a'}.</p>
      ${rejected}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadTokens() {
    const data = await api('/api/tokens');
    tokens = data;
    const sel = $('origin');
    if (!sel) return;
    sel.innerHTML = data.usdc.map(t => `<option value="${esc(t.assetId)}">${esc(t.symbol)} on ${esc(chainName(t.blockchain))}</option>`).join('');
    const eth = data.usdc.find(t => t.blockchain === 'eth');
    if (eth) sel.value = eth.assetId;
    updateHints();
    renderChainStrip(data.usdc || []);
    startRouteCycle(data.usdc || []);
    loadTicker();
  }

  function renderChainStrip(usdc) {
    const el = $('chain-strip');
    if (!el) return;
    el.innerHTML = usdc.map(t => {
      const href = '#create';
      return `<a class="chip" href="${href}" data-chain="${esc(t.blockchain)}"><i></i>${esc(chainName(t.blockchain))}</a>`;
    }).join('');
    el.querySelectorAll('[data-chain]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const tok = tokens.usdc.find(t => t.blockchain === a.dataset.chain);
        if (tok && $('origin')) {
          $('origin').value = tok.assetId;
          updateHints();
        }
        document.getElementById('create')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  let routeTimer = null;
  function startRouteCycle(usdc) {
    const el = $('route-chain');
    if (!el || !usdc.length) return;
    const names = usdc.map(t => chainName(t.blockchain));
    let i = Math.max(0, names.indexOf('Ethereum'));
    el.textContent = 'on ' + names[i];
    if (routeTimer) clearInterval(routeTimer);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    routeTimer = setInterval(() => {
      i = (i + 1) % names.length;
      el.textContent = 'on ' + names[i];
    }, 2200);
  }

  async function loadTicker() {
    const body = $('ticker-body');
    const meta = $('ticker-meta');
    const lab = $('ticker-label');
    const dot = $('ticker-dot');
    if (!body) return;
    try {
      const data = await api('/api/ticker');
      if (lab) lab.textContent = 'Live 1Click dry quotes';
      if (meta) {
        const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : '';
        meta.textContent = `${data.amountHuman || 50} ${data.originSymbol || 'USDC'} on ${chainName(data.originChain || 'eth')}${when ? ' · ' + when : ''}`;
      }
      if (dot) dot.classList.remove('err');
      body.innerHTML = (data.quotes || []).map((q) => {
        if (q.error) {
          return `<div class="tick"><div class="t-k">${esc(q.target)}</div><div class="t-err">${esc(q.error)}</div></div>`;
        }
        const out = (q.destSymbol || q.target || '').toUpperCase() === 'BTC' && q.amountOut
          ? Math.round(q.amountOut * 1e8).toLocaleString('en-US') + ' sats'
          : `${fmtAmt(q.amountOut, 6)} ${esc(q.destSymbol || q.target)}`;
        const fee = q.feeUsd != null ? `Fees ${fmtUsd(q.feeUsd)}` : '';
        const slip = q.priceSlippageBps != null ? `${fmtAmt(q.priceSlippageBps, 0)} bps after fees` : '';
        return `<div class="tick">
          <div class="t-k">${esc(q.target)} · ${fmtUsd(q.amountInUsd)} in</div>
          <div class="t-v">${out}</div>
          <div class="t-d">${[fmtUsd(q.amountOutUsd), fee, slip].filter(Boolean).join(' · ')}</div>
        </div>`;
      }).join('');
    } catch (e) {
      if (dot) dot.classList.add('err');
      if (lab) lab.textContent = 'Quotes unavailable';
      if (meta) meta.textContent = e.message;
      body.innerHTML = `<div class="tick"><div class="t-err">${esc(e.message)}</div></div>`;
    }
  }

  $('preview')?.addEventListener('click', async () => {
    const err = $('form-err');
    err.textContent = '';
    $('preview').disabled = true;
    if ($('preview-empty')) $('preview-empty').hidden = true;
    if ($('preview-body')) $('preview-body').hidden = true;
    if ($('preview-skel')) $('preview-skel').hidden = false;
    try {
      const b = formBody();
      const origin = tokens.usdc.find(t => t.assetId === b.originAsset);
      const dest = tokens.targets[b.target];
      if (!origin) throw new Error('Pick a USDC origin chain');
      if (!dest) throw new Error('Pick a target asset');
      if (!b.recipient || !b.refundTo) throw new Error('Destination and refund addresses are needed for a quote');
      const amount = toUnits(b.amountHuman, origin.decimals);
      const data = await api('/api/quote', {
        method: 'POST',
        body: JSON.stringify({
          dry: true,
          originAsset: b.originAsset,
          destinationAsset: dest.assetId,
          amount,
          recipient: b.recipient,
          refundTo: b.refundTo,
          slippageTolerance: b.slippageBps,
        }),
      });
      if ($('preview-skel')) $('preview-skel').hidden = true;
      $('preview-empty').hidden = true;
      $('preview-body').hidden = false;
      $('preview-body').innerHTML = renderFeeBox(data.analysis, data.quote);
    } catch (e) {
      if ($('preview-skel')) $('preview-skel').hidden = true;
      if ($('preview-empty')) $('preview-empty').hidden = false;
      err.textContent = e.message;
    } finally {
      $('preview').disabled = false;
    }
  });

  function toUnits(human, decimals) {
    const n = String(human || '').trim();
    if (!/^\d+(\.\d+)?$/.test(n)) throw new Error('Amount must be a positive number');
    const [w, f = ''] = n.split('.');
    if (f.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
    const raw = (w + f.padEnd(decimals, '0')).replace(/^0+/, '') || '0';
    if (raw === '0') throw new Error('Amount must be greater than zero');
    return raw;
  }


  $('plan-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('form-err');
    err.textContent = '';
    if (mode === 'live' && !$('live-ack').checked) {
      err.textContent = 'Please confirm you understand live mode before creating a live plan.';
      return;
    }
    try {
      const data = await api('/api/plans', { method: 'POST', body: JSON.stringify(formBody()) });
      location.hash = '#/p/' + data.plan.id;
    } catch (e) {
      err.textContent = e.message;
    }
  });

  function route() {
    const m = location.hash.match(/^#\/p\/([a-f0-9]{24})$/);
    if (m) showPlan(m[1]);
    else showHome();
  }

  function showHome() {
    $('home-view').classList.remove('hide');
    $('plan-view').classList.remove('show');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  async function showPlan(id) {
    $('home-view').classList.add('hide');
    $('plan-view').classList.add('show');
    $('plan-err').textContent = '';
    try {
      const data = await api('/api/plans/' + id);
      renderPlan(data);
    } catch (e) {
      $('plan-err').textContent = e.message;
    }
  }

  function renderPlan(data) {
    const p = data.plan;
    $('plan-title').textContent = `${p.amountHuman} USDC → ${p.destinationSymbol}`;
    $('plan-badges').innerHTML = `
      <span class="badge ${p.mode}">${p.mode === 'live' ? 'Live' : 'Dry-run'}</span>
      <span class="badge">${esc(intervalLabel(p.interval))}</span>
      <span class="badge">${esc(p.originSymbol)} on ${esc(p.originChain)}</span>
      <span class="badge">${esc(p.slippageBps)} bps limit</span>
      <span class="badge">${p.paused ? 'Paused' : (data.open ? 'Active' : 'Finished')}</span>`;
    const funds = data.funds || {};
    $('funds-where').textContent = funds.where || 'Your wallet';
    $('funds-detail').textContent = funds.detail || '';
    renderDeposit(p);
    $('plan-kpis').innerHTML = `
      <div class="kpi"><div class="k">Buys recorded</div><div class="v">${p.buysDone || 0}${p.maxBuys ? ' / ' + p.maxBuys : ''}</div><div class="d">${p.skipped || 0} skipped for slippage</div></div>
      <div class="kpi"><div class="k">Next due</div><div class="v">${data.open ? rel(p.nextDueAt) : '—'}</div><div class="d">${p.nextDueAt ? new Date(p.nextDueAt).toLocaleString() : ''}</div></div>
      <div class="kpi"><div class="k">Destination</div><div class="v" style="font-size:14px;word-break:break-all">${esc(short(p.recipient))}</div><div class="d">Refund ${esc(short(p.refundTo))}</div></div>`;
    $('plan-actions').innerHTML = `
      <button class="btn pri" id="btn-buy">${p.mode === 'live' ? 'Buy this interval (live)' : 'Run next buy (dry)'}</button>
      <button class="btn" id="btn-pause">${p.paused ? 'Resume' : 'Pause'}</button>`;
    $('btn-buy').onclick = () => doBuy(p);
    $('btn-pause').onclick = async () => {
      try {
        await api('/api/plans/' + p.id + '/pause', { method: 'POST', body: JSON.stringify({ paused: !p.paused }) });
        showPlan(p.id);
      } catch (e) { $('plan-err').textContent = e.message; }
    };
    renderHistory(data.history || []);
    setupPolling(p);
  }

  function intervalLabel(i) {
    return ({ '5m': 'every 5 min', '15m': 'every 15 min', '1h': 'hourly', '1d': 'daily', '1w': 'weekly' })[i] || i;
  }
  function rel(iso) {
    if (!iso) return '—';
    const s = Math.round((new Date(iso) - Date.now()) / 1000);
    if (s <= 0) return 'now';
    if (s < 90) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  function renderDeposit(p) {
    const box = $('deposit-box');
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    const pend = p.pending;
    if (!pend?.depositAddress) { box.innerHTML = ''; return; }
    const end = new Date(pend.deadline || pend.timeWhenInactive || Date.now() + 10 * 60 * 1000).getTime();
    box.innerHTML = `
      <div class="deposit">
        <div class="lab" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:700">Send exactly ${esc(p.amountHuman)} USDC to this address</div>
        <code id="dep-addr">${esc(pend.depositAddress)}</code>
        ${pend.depositMemo ? `<p class="hint">Memo required: <b>${esc(pend.depositMemo)}</b></p>` : ''}
        <div class="row-actions">
          <button class="btn" type="button" id="copy-dep">Copy address</button>
          <span class="countdown" id="cd">Expires in —</span>
        </div>
        <p class="hint">Do not send a different amount, and do not reuse this address after it expires.</p>
      </div>`;
    $('copy-dep').onclick = async () => {
      try { await navigator.clipboard.writeText(pend.depositAddress); $('copy-dep').textContent = 'Copied'; } catch {}
    };
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      const el = $('cd');
      if (el) el.textContent = left === 0 ? 'This quote may have expired. Request a new buy.' : `Expires in ${m}:${String(s).padStart(2, '0')}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function renderHistory(rows) {
    const tb = $('hist-body');
    if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="6"><div class="empty-state tight"><div class="empty-ico" aria-hidden="true">◎</div><p>No buys yet. Run a dry buy to fetch a real 1Click quote.</p></div></td></tr>'; return; }
    tb.innerHTML = rows.map(r => {
      const a = r.analysis || {};
      const links = (r.explorers || []).map(l => `<a href="${esc(l.url)}" rel="noopener" target="_blank">${esc(l.label)}</a>`).join(' · ');
      const when = r.at ? new Date(r.at).toLocaleString() : '';
      return `<tr>
        <td>${esc(when)}</td>
        <td><span class="badge ${badgeClass(r.kind)}">${esc(r.kind.replace(/_/g, ' '))}</span>${r.dry ? ' <span class="badge dry">dry</span>' : ''}</td>
        <td class="num">${fmtAmt(a.amountIn, 6)} ${esc(a.originSymbol || 'USDC')}</td>
        <td class="num">${(a.destSymbol || '').toUpperCase()==='BTC' && a.amountOut ? Math.round(a.amountOut * 1e8).toLocaleString('en-US') + ' sats' : `${fmtAmt(a.amountOut, 8)} ${esc(a.destSymbol || '')}`}</td>
        <td class="num">${fmtUsd(a.feeUsd)} · ${fmtAmt(a.priceSlippageBps, 0)} bps</td>
        <td>${links || (r.depositAddress ? `<span class="mono">${esc(short(r.depositAddress))}</span>` : '—')}</td>
      </tr>`;
    }).join('');
  }

  async function doBuy(p) {
    $('plan-err').textContent = '';
    const btn = $('btn-buy');
    if (btn) btn.disabled = true;
    try {
      const body = p.mode === 'live' ? { live: true } : { dry: true };
      if (p.mode === 'live' && !confirm('This will request a real mainnet deposit address. You will have to send USDC yourself. Continue?')) {
        if (btn) btn.disabled = false;
        return;
      }
      await api('/api/plans/' + p.id + '/buy', { method: 'POST', body: JSON.stringify(body) });
      await showPlan(p.id);
    } catch (e) {
      $('plan-err').textContent = e.message;
      if (btn) btn.disabled = false;
    }
  }

  function setupPolling(p) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (p.mode === 'live' && p.pending?.depositAddress) {
      pollTimer = setInterval(() => showPlan(p.id), 8000);
    }
  }

  function sparkSvg(vals) {
    if (!vals || vals.length < 2) return '';
    const w = 640, h = 72, p = 4;
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const pts = vals.map((v, i) => {
      const x = p + (i / (vals.length - 1)) * (w - p * 2);
      const y = h - p - ((v - min) / span) * (h - p * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="sim-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="2.2" points="${pts}" style="color:var(--near-d)"/></svg>`;
  }

  $('sim-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('sim-err');
    const out = $('sim-results');
    const skel = $('sim-skel');
    err.textContent = '';
    if (out) out.hidden = true;
    if (skel) skel.hidden = false;
    const btn = $('sim-run');
    if (btn) btn.disabled = true;
    try {
      const q = new URLSearchParams({
        asset: $('sim-asset').value,
        amount: $('sim-amount').value.trim(),
        weeks: $('sim-weeks').value,
      });
      const data = await api('/api/simulate?' + q.toString());
      if (skel) skel.hidden = true;
      if (!out) return;
      const sign = (n) => (n >= 0 ? '+' : '−') + fmtUsd(Math.abs(n)).replace('$', '');
      const vsCls = data.vsSpent >= 0 ? 'okmsg' : 'err';
      out.hidden = false;
      out.innerHTML = `
        <div class="sim-kpis">
          <div class="kpi"><div class="k">Spent</div><div class="v">${fmtUsd(data.spent)}</div><div class="d">${data.weeksUsed} weekly buys of ${fmtUsd(data.amount)}</div></div>
          <div class="kpi"><div class="k">Bought</div><div class="v">${fmtAmt(data.coins, 6)}</div><div class="d">${esc(data.asset)} · avg ${fmtUsd(data.avgPrice)}</div></div>
          <div class="kpi"><div class="k">Value now</div><div class="v">${fmtUsd(data.valueNow)}</div><div class="d ${vsCls}">${sign(data.vsSpent)} vs spent</div></div>
          <div class="kpi"><div class="k">Vs lump sum</div><div class="v">${sign(data.vsLump)}</div><div class="d">Lump at first price would be ${fmtUsd(data.lumpValue)}</div></div>
        </div>
        ${sparkSvg(data.spark)}
        <p class="sim-note">${esc(data.note)} ${data.firstBuyAt && data.lastPriceAt ? `Window: ${esc(data.firstBuyAt)} to ${esc(data.lastPriceAt)}. ` : ''}Source: <a href="${esc(data.sourceUrl)}" rel="noopener">CoinGecko</a>.</p>`;
    } catch (e) {
      if (skel) skel.hidden = true;
      err.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  window.addEventListener('hashchange', route);
  loadTokens().then(route).catch((e) => {
    const el = $('form-err');
    if (el) el.textContent = e.message;
  });
})();
