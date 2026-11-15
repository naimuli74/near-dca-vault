import { fetchTokens, getQuote, getStatus, submitDeposit, analyzeQuote, explorerLinks, usdcOptions, TARGETS, findToken } from './oneclick.js';
import { putPlan, getPlan, listPlans, getHistory, appendHistory, cachedTokens } from './store.js';
import { createPlan, isDue, advancePlan, planOpen, fundsLocation, newId, INTERVALS } from './plans.js';
import { getTicker, simulateDca } from './market.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function err(message, status = 400, extra) {
  return json({ ok: false, message, ...extra }, status);
}

async function tokens(env) {
  return cachedTokens(env, fetchTokens);
}

function quoteBodyFromPlan(plan, dry) {
  return {
    dry,
    originAsset: plan.originAsset,
    destinationAsset: plan.destinationAsset,
    amount: plan.amount,
    recipient: plan.recipient,
    refundTo: plan.refundTo,
    slippageTolerance: plan.slippageBps,
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    refundType: 'ORIGIN_CHAIN',
  };
}

function historyEvent(kind, { plan, quoteRes, analysis, status, dry }) {
  const depositAddress = quoteRes?.depositAddress || status?.quoteResponse?.depositAddress || plan?.pending?.depositAddress || null;
  const st = status?.status || kind;
  const funds = fundsLocation(kind === 'DRY_QUOTED' || kind === 'SKIPPED_SLIPPAGE' ? kind : st, plan);
  return {
    id: newId(),
    at: new Date().toISOString(),
    kind,
    dry: !!dry,
    status: st,
    depositAddress,
    correlationId: quoteRes?.correlationId || status?.correlationId || null,
    quote: quoteRes?.quote || status?.quoteResponse?.quote || null,
    analysis: analysis || null,
    funds,
    explorers: explorerLinks(status, depositAddress),
    timeWhenInactive: quoteRes?.timeWhenInactive || null,
    deadline: quoteRes?.deadline || quoteRes?.quoteRequest?.deadline || null,
  };
}

async function runBuy(env, plan, { dry, force = false }) {
  if (!force && !isDue(plan) && dry) {
    // Manual dry runs are always allowed; cron uses force=false and isDue.
  }
  const list = await tokens(env);
  const quoteRes = await getQuote(quoteBodyFromPlan(plan, dry));
  const analysis = analyzeQuote(quoteRes, list, plan.slippageBps);
  const now = Date.now();

  if (analysis.rejected) {
    plan.skipped = (plan.skipped || 0) + 1;
    if (isDue(plan, now) || force) advancePlan(plan, now);
    await putPlan(env, plan);
    const ev = historyEvent('SKIPPED_SLIPPAGE', { plan, quoteRes, analysis, dry: true });
    const history = await appendHistory(env, plan.id, ev);
    return { ok: true, skipped: true, plan, event: ev, history, analysis, quote: quoteRes };
  }

  if (dry) {
    plan.buysDone = (plan.buysDone || 0) + 1;
    if (isDue(plan, now) || force) advancePlan(plan, now);
    plan.pending = null;
    await putPlan(env, plan);
    const ev = historyEvent('DRY_QUOTED', { plan, quoteRes, analysis, dry: true });
    const history = await appendHistory(env, plan.id, ev);
    return { ok: true, dry: true, plan, event: ev, history, analysis, quote: quoteRes };
  }

  // Live, non-custodial: issue a wet quote and wait for the user to send funds.
  const depositAddress = quoteRes.depositAddress;
  if (!depositAddress) {
    throw new Error('Live quote did not return a deposit address');
  }
  plan.pending = {
    depositAddress,
    depositMemo: quoteRes.depositMemo || null,
    deadline: quoteRes.deadline || quoteRes.timeWhenInactive || null,
    timeWhenInactive: quoteRes.timeWhenInactive || null,
    quotedAt: new Date(now).toISOString(),
    correlationId: quoteRes.correlationId || null,
    amount: plan.amount,
    quote: quoteRes.quote,
    analysis,
  };
  await putPlan(env, plan);
  const ev = historyEvent('PENDING_DEPOSIT', { plan, quoteRes, analysis, dry: false });
  const history = await appendHistory(env, plan.id, ev);
  return { ok: true, dry: false, plan, event: ev, history, analysis, quote: quoteRes };
}

async function refreshPending(env, plan) {
  if (!plan.pending?.depositAddress) return { plan, status: null };
  const status = await getStatus(plan.pending.depositAddress, plan.pending.depositMemo);
  const st = status.status;
  const list = await tokens(env);
  const quoteRes = status.quoteResponse || { quote: plan.pending.quote, depositAddress: plan.pending.depositAddress };
  const analysis = plan.pending.analysis || analyzeQuote(quoteRes, list, plan.slippageBps);
  const terminal = ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(st);
  if (terminal) {
    if (st === 'SUCCESS') plan.buysDone = (plan.buysDone || 0) + 1;
    advancePlan(plan, Date.now());
    plan.pending = null;
    await putPlan(env, plan);
    const ev = historyEvent(st, { plan, quoteRes, analysis, status, dry: false });
    await appendHistory(env, plan.id, ev);
  } else if (st === 'KNOWN_DEPOSIT_TX' || st === 'PROCESSING') {
    const ev = historyEvent(st, { plan, quoteRes, analysis, status, dry: false });
    const hist = await getHistory(env, plan.id);
    if (hist[0]?.kind !== st) await appendHistory(env, plan.id, ev);
    await putPlan(env, plan);
  }
  return { plan, status };
}

async function handleApi(req, env) {
  const u = new URL(req.url);
  const path = u.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'near-dca-vault', dryDefault: true, now: new Date().toISOString() });
  }

  if (method === 'GET' && path === '/api/tokens') {
    const list = await tokens(env);
    return json({
      ok: true,
      usdc: usdcOptions(list).map(t => ({
        assetId: t.assetId,
        symbol: t.symbol,
        blockchain: t.blockchain,
        decimals: t.decimals,
        price: t.price,
        contractAddress: t.contractAddress,
      })),
      targets: TARGETS,
      intervals: Object.keys(INTERVALS),
    });
  }

  if (method === 'POST' && path === '/api/quote') {
    const body = await req.json().catch(() => ({}));
    const list = await tokens(env);
    // Preview quotes are always dry. Never issue a deposit address from this route.
    const quoteRes = await getQuote({ ...body, dry: true });
    const analysis = analyzeQuote(quoteRes, list, body.slippageTolerance ?? body.slippageBps);
    return json({ ok: true, dry: true, quote: quoteRes, analysis });
  }

  if (method === 'POST' && path === '/api/plans') {
    const body = await req.json().catch(() => ({}));
    const list = await tokens(env);
    const plan = createPlan(body, list);
    await putPlan(env, plan);
    return json({ ok: true, plan }, 201);
  }

  const planMatch = path.match(/^\/api\/plans\/([a-f0-9]{24})(?:\/(buy|pause|history))?$/);
  if (planMatch) {
    const id = planMatch[1];
    const action = planMatch[2] || '';
    const plan = await getPlan(env, id);
    if (!plan) return err('Plan not found', 404);

    if (method === 'GET' && path === `/api/plans/${id}`) {
      if (plan.pending?.depositAddress) {
        try { await refreshPending(env, plan); } catch {}
      }
      const latest = await getPlan(env, id);
      const history = await getHistory(env, id);
      const funds = latest.pending
        ? fundsLocation(history[0]?.status || 'PENDING_DEPOSIT', latest)
        : fundsLocation(history[0]?.kind || 'IDLE', latest);
      return json({ ok: true, plan: latest, history, funds, open: planOpen(latest), due: isDue(latest) });
    }

    if (method === 'POST' && path === `/api/plans/${id}/buy`) {
      const body = await req.json().catch(() => ({}));
      const live = body.live === true || body.dry === false;
      if (live) {
        if (plan.mode !== 'live') return err('This plan is dry-run only. Create a live plan to issue a deposit address.', 400);
        if (plan.pending?.depositAddress) {
          return err('A live buy is already waiting for a deposit. Use that address, or wait for it to expire.', 409, { plan });
        }
        const result = await runBuy(env, plan, { dry: false, force: true });
        return json(result);
      }
      const result = await runBuy(env, plan, { dry: true, force: true });
      return json(result);
    }

    if (method === 'POST' && path === `/api/plans/${id}/pause`) {
      const body = await req.json().catch(() => ({}));
      plan.paused = body.paused !== false;
      await putPlan(env, plan);
      return json({ ok: true, plan });
    }

    if (method === 'GET' && path === `/api/plans/${id}/history`) {
      return json({ ok: true, history: await getHistory(env, id) });
    }
  }

  if (method === 'GET' && path === '/api/status') {
    const depositAddress = u.searchParams.get('depositAddress');
    if (!depositAddress) return err('depositAddress is required');
    const status = await getStatus(depositAddress, u.searchParams.get('depositMemo'));
    return json({
      ok: true,
      status,
      funds: fundsLocation(status.status, null),
      explorers: explorerLinks(status, depositAddress),
    });
  }

  if (method === 'GET' && path === '/api/ticker') {
    const list = await tokens(env);
    const data = await getTicker(env, list);
    return json(data);
  }

  if (method === 'GET' && path === '/api/simulate') {
    const asset = u.searchParams.get('asset') || 'BTC';
    const amount = u.searchParams.get('amount') || '50';
    const weeks = u.searchParams.get('weeks') || '52';
    const data = await simulateDca(env, { asset, amount, weeks });
    return json(data);
  }

  if (method === 'POST' && path === '/api/deposit/submit') {
    const body = await req.json().catch(() => ({}));
    if (!body.depositAddress || !body.txHash) return err('depositAddress and txHash are required');
    const out = await submitDeposit(body.depositAddress, body.txHash);
    return json({ ok: true, result: out });
  }

  return err('Not found', 404);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    try {
      if (u.pathname.startsWith('/api/')) return await handleApi(req, env);
      return await serveStatic(u.pathname, env);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const status = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      return err(message, status, e && e.body ? { detail: e.body } : undefined);
    }
  },

  async scheduled(event, env) {
    const plans = await listPlans(env);
    const results = [];
    for (const plan of plans) {
      try {
        if (plan.pending?.depositAddress) {
          await refreshPending(env, plan);
          results.push({ id: plan.id, action: 'poll' });
          continue;
        }
        if (plan.mode === 'dry' && isDue(plan)) {
          await runBuy(env, plan, { dry: true, force: false });
          results.push({ id: plan.id, action: 'dry-tick' });
        }
      } catch (e) {
        results.push({ id: plan.id, action: 'error', message: e.message });
      }
    }
    console.log('cron', event.cron, results.length, JSON.stringify(results).slice(0, 1000));
  },
};

// Filled in by scripts/build.mjs
async function serveStatic(pathname, env) {
  if (typeof ASSETS === 'undefined') return new Response('build missing ASSETS', { status: 500 });
  const path = pathname === '/' || pathname === '/index.html' ? '/index.html' : pathname;
  const asset = ASSETS[path];
  if (!asset) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const headers = {
    'content-type': asset.type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cache-control': asset.immutable ? 'public, max-age=86400' : 'public, max-age=60',
    'access-control-allow-origin': '*',
  };
  return new Response(asset.body, { headers });
}
