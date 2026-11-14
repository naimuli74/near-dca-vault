const API = 'https://1click.chaindefuser.com/v0';

export const TARGETS = {
  BTC: { symbol: 'BTC', chain: 'btc', label: 'Bitcoin', assetId: 'nep141:btc.omft.near' },
  ETH: { symbol: 'ETH', chain: 'eth', label: 'Ether', assetId: 'nep141:eth.omft.near' },
  NEAR: { symbol: 'wNEAR', chain: 'near', label: 'NEAR (wNEAR)', assetId: 'nep141:wrap.near' },
};

export const EVM_CHAINS = new Set([
  'eth', 'arb', 'base', 'op', 'pol', 'avax', 'bsc', 'gnosis', 'scroll',
  'bera', 'monad', 'xlayer', 'hood', 'abs', 'plasma', 'adi',
]);

export async function fetchTokens() {
  const res = await fetch(`${API}/tokens`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`tokens ${res.status}`);
  return res.json();
}

export function usdcOptions(tokens) {
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if ((t.symbol || '').toUpperCase() !== 'USDC') continue;
    if (seen.has(t.blockchain)) continue;
    seen.add(t.blockchain);
    out.push(t);
  }
  const prefer = ['eth', 'base', 'arb', 'sol', 'near', 'op', 'pol', 'avax'];
  out.sort((a, b) => {
    const ia = prefer.indexOf(a.blockchain), ib = prefer.indexOf(b.blockchain);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return out;
}

export function findToken(tokens, assetId) {
  return tokens.find(t => t.assetId === assetId) || null;
}

export async function getQuote(body) {
  const deadline = body.deadline || new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const payload = {
    dry: body.dry !== false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: Number(body.slippageTolerance ?? 100),
    originAsset: body.originAsset,
    depositType: body.depositType || 'ORIGIN_CHAIN',
    destinationAsset: body.destinationAsset,
    amount: String(body.amount),
    recipient: body.recipient,
    recipientType: body.recipientType || 'DESTINATION_CHAIN',
    refundTo: body.refundTo,
    refundType: body.refundType || 'ORIGIN_CHAIN',
    deadline,
    referral: 'dcavault',
    quoteWaitingTimeMs: body.quoteWaitingTimeMs ?? 0,
  };
  const res = await fetch(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `quote ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function getStatus(depositAddress, depositMemo) {
  const u = new URL(`${API}/status`);
  u.searchParams.set('depositAddress', depositAddress);
  if (depositMemo) u.searchParams.set('depositMemo', depositMemo);
  const res = await fetch(u, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({ message: `status ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.message || `status ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function submitDeposit(depositAddress, txHash) {
  const res = await fetch(`${API}/deposit/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ depositAddress, txHash }),
  });
  const data = await res.json().catch(() => ({ message: `deposit/submit ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.message || `deposit/submit ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function dec(token, fallback = 6) {
  return Number(token?.decimals ?? fallback);
}

function unitsToNumber(amount, decimals) {
  if (amount == null || amount === '') return 0;
  const s = String(amount);
  const d = Number(decimals);
  if (!Number.isFinite(d) || d < 0) return Number(s) || 0;
  if (s.length <= d) return Number(`0.${s.padStart(d, '0')}`);
  return Number(`${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`);
}

export function analyzeQuote(quoteRes, tokens, slippageBps) {
  const q = quoteRes?.quote || {};
  const req = quoteRes?.quoteRequest || {};
  const origin = findToken(tokens, req.originAsset);
  const dest = findToken(tokens, req.destinationAsset);
  const originDec = dec(origin, 6);
  const destDec = dec(dest, 8);
  const originPrice = Number(origin?.price || 0);
  const destPrice = Number(dest?.price || 0);
  const amountIn = unitsToNumber(q.amountIn, originDec);
  const amountOut = unitsToNumber(q.amountOut, destDec);
  const minAmountOut = unitsToNumber(q.minAmountOut, destDec);
  const amountInUsd = q.amountInUsd != null ? Number(q.amountInUsd) : amountIn * originPrice;
  const amountOutUsd = q.amountOutUsd != null ? Number(q.amountOutUsd) : amountOut * destPrice;
  const withdrawFee = unitsToNumber(q.withdrawFee, destDec);
  const refundFee = unitsToNumber(q.refundFee, originDec);
  const withdrawFeeUsd = withdrawFee * (destPrice || 0);
  const refundFeeUsd = refundFee * (originPrice || 0);
  const appFeeBps = Array.isArray(req.appFees)
    ? req.appFees.reduce((s, f) => s + Number(f.fee || 0), 0)
    : 0;
  const appFeeUsd = amountInUsd * (appFeeBps / 10000);
  const feeUsd = withdrawFeeUsd + refundFeeUsd + appFeeUsd;
  const grossBps = amountInUsd > 0 ? ((amountInUsd - amountOutUsd) / amountInUsd) * 10000 : 0;
  const feeBps = amountInUsd > 0 ? (feeUsd / amountInUsd) * 10000 : 0;
  const priceSlippageBps = grossBps - feeBps;
  const limit = Number(slippageBps ?? req.slippageTolerance ?? 100);
  const rejected = Number.isFinite(priceSlippageBps) && priceSlippageBps > limit + 1;
  const midOut = destPrice > 0 && amountInUsd > 0 ? (amountInUsd - feeUsd) / destPrice : null;
  return {
    amountIn,
    amountOut,
    minAmountOut,
    amountInUsd,
    amountOutUsd,
    withdrawFee,
    refundFee,
    withdrawFeeUsd,
    refundFeeUsd,
    appFeeBps,
    appFeeUsd,
    feeUsd,
    grossBps,
    feeBps,
    priceSlippageBps,
    slippageLimitBps: limit,
    midOut,
    rejected,
    reason: rejected
      ? `Quote rejected: after known fees, the price is ${priceSlippageBps.toFixed(0)} bps worse than mid-market, above your ${limit} bps limit.`
      : null,
    timeEstimate: q.timeEstimate,
    originSymbol: origin?.symbol || 'USDC',
    destSymbol: dest?.symbol || 'TOKEN',
    originDecimals: originDec,
    destDecimals: destDec,
  };
}

export function explorerLinks(status, depositAddress) {
  const links = [];
  if (depositAddress) {
    links.push({
      label: 'NEAR Intents explorer',
      url: `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`,
    });
  }
  const details = status?.swapDetails || {};
  for (const t of details.originChainTxHashes || []) {
    if (t.explorerUrl) links.push({ label: 'Origin tx', url: t.explorerUrl, hash: t.hash });
  }
  for (const t of details.destinationChainTxHashes || []) {
    if (t.explorerUrl) links.push({ label: 'Destination tx', url: t.explorerUrl, hash: t.hash });
  }
  return links;
}

export function amountToUnits(human, decimals) {
  const n = String(human || '').trim();
  if (!/^\d+(\.\d+)?$/.test(n)) throw new Error('Amount must be a positive number');
  const [w, f = ''] = n.split('.');
  if (f.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  const frac = f.padEnd(decimals, '0');
  const raw = (w + frac).replace(/^0+/, '') || '0';
  if (raw === '0') throw new Error('Amount must be greater than zero');
  return raw;
}
