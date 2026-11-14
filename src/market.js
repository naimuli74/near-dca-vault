// Live ticker (1Click dry quotes) and CoinGecko-backed DCA simulator.
// Sample addresses are public examples used only for dry quotes. Nothing is sent.

const TICKER_KEY = 'cache:ticker';
const TICKER_TTL_MS = 90 * 1000;
const PRICE_TTL_MS = 6 * 60 * 60 * 1000;

const SAMPLE = {
  BTC: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // BIP-173 example
  ETH: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  NEAR: 'near',
  refundEth: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
};

const CG_IDS = { BTC: 'bitcoin', ETH: 'ethereum', NEAR: 'near' };

const TICKER_AMOUNT_HUMAN = '50';

export async function kvCache(env, key, ttlMs, expTtlSec, fetcher) {
  const raw = await env.PLANS.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.at && Date.now() - parsed.at < ttlMs && parsed.data != null) {
        return { ...parsed.data, cached: true, fetchedAt: new Date(parsed.at).toISOString() };
      }
    } catch {}
  }
  const data = await fetcher();
  await env.PLANS.put(key, JSON.stringify({ at: Date.now(), data }), {
    expirationTtl: Math.max(60, expTtlSec || Math.ceil(ttlMs / 1000) * 2),
  });
  return { ...data, cached: false, fetchedAt: new Date().toISOString() };
}

function unitsFor(human, decimals) {
  const [w, f = ''] = String(human).split('.');
  return (w + f.padEnd(decimals, '0')).replace(/^0+/, '') || '0';
}

export async function getTicker(env, list) {
  return kvCache(env, TICKER_KEY, TICKER_TTL_MS, 180, async () => {
    const origin = usdcOptions(list).find((t) => t.blockchain === 'eth') || usdcOptions(list)[0];
    if (!origin) throw new Error('No USDC origin token is available');
    const amount = unitsFor(TICKER_AMOUNT_HUMAN, origin.decimals ?? 6);
    const quotes = [];
    for (const key of ['BTC', 'ETH', 'NEAR']) {
      const dest = TARGETS[key];
      try {
        const quoteRes = await getQuote({
          dry: true,
          originAsset: origin.assetId,
          destinationAsset: dest.assetId,
          amount,
          recipient: SAMPLE[key],
          refundTo: SAMPLE.refundEth,
          slippageTolerance: 100,
          depositType: 'ORIGIN_CHAIN',
          recipientType: 'DESTINATION_CHAIN',
          refundType: 'ORIGIN_CHAIN',
        });
        const analysis = analyzeQuote(quoteRes, list, 100);
        const q = quoteRes?.quote || {};
        quotes.push({
          target: key,
          label: dest.label,
          destSymbol: analysis.destSymbol || dest.symbol,
          amountIn: analysis.amountIn,
          amountInUsd: analysis.amountInUsd,
          amountOut: analysis.amountOut,
          amountOutUsd: analysis.amountOutUsd,
          feeUsd: analysis.feeUsd,
          appFeeBps: analysis.appFeeBps,
          withdrawFeeUsd: analysis.withdrawFeeUsd,
          priceSlippageBps: analysis.priceSlippageBps,
          timeEstimateMin: q.timeEstimate ? Math.round(q.timeEstimate / 60) : null,
          ok: !analysis.rejected,
        });
      } catch (e) {
        quotes.push({ target: key, label: dest.label, error: e.message || String(e) });
      }
    }
    return {
      ok: true,
      amountHuman: TICKER_AMOUNT_HUMAN,
      originSymbol: origin.symbol,
      originChain: origin.blockchain,
      quotes,
      note: 'Live unauthenticated 1Click dry quotes for 50 USDC on Ethereum, using public example addresses. Nothing is deposited.',
    };
  });
}

async function fetchCoinGeckoChart(coinId, days) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'near-dca-vault/1.0 (https://dca.darkhouse.online; educational simulator)',
    },
  });
  if (!res.ok) {
    const err = new Error(`CoinGecko returned ${res.status}`);
    err.status = res.status === 429 ? 503 : 502;
    throw err;
  }
  const body = await res.json();
  const series = Array.isArray(body.prices) ? body.prices : [];
  if (series.length < 8) throw new Error('CoinGecko did not return enough price points');
  return series
    .map(([t, p]) => ({ t: Number(t), p: Number(p) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0);
}

const COINBASE_PRODUCTS = { bitcoin: 'BTC-USD', ethereum: 'ETH-USD', near: 'NEAR-USD' };

async function fetchCoinbaseDaily(coinId) {
  const product = COINBASE_PRODUCTS[coinId];
  if (!product) throw new Error('No Coinbase fallback for this asset');
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Coinbase returned ${res.status}`);
    err.status = 502;
    throw err;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 8) throw new Error('Coinbase did not return enough price points');
  return rows
    .map((row) => ({ t: Number(row[0]) * 1000, p: Number(row[4]) }))
    .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p) && x.p > 0)
    .sort((a, b) => a.t - b.t);
}

export async function getDailyPrices(env, asset) {
  const id = CG_IDS[String(asset || '').toUpperCase()];
  if (!id) throw new Error('Asset must be BTC, ETH or NEAR');
  return kvCache(env, 'cache:prices:' + id, PRICE_TTL_MS, 8 * 60 * 60, async () => {
    let points, source, sourceUrl;
    try {
      points = await fetchCoinGeckoChart(id, 400);
      source = 'CoinGecko';
      sourceUrl = 'https://www.coingecko.com/en/coins/' + id;
    } catch (e) {
      // Free CoinGecko is often rate-limited; fall back to Coinbase Exchange public daily closes.
      points = await fetchCoinbaseDaily(id);
      source = 'Coinbase';
      sourceUrl = 'https://www.coinbase.com';
    }
    return {
      ok: true,
      asset: String(asset).toUpperCase(),
      coinId: id,
      source,
      sourceUrl,
      points,
    };
  });
}

export async function simulateDca(env, { asset, amount, weeks }) {
  const a = String(asset || 'BTC').toUpperCase();
  const amt = Number(amount);
  const nWeeks = Number(weeks);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 100000) {
    throw new Error('Amount must be a positive number, up to 100000');
  }
  if (!Number.isFinite(nWeeks) || nWeeks < 2 || nWeeks > 52) {
    throw new Error('Weeks must be between 2 and 52');
  }
  const prices = await getDailyPrices(env, a);
  const pts = prices.points || [];
  // Walk back weekly from the latest close.
  const latest = pts[pts.length - 1];
  const buys = [];
  for (let w = nWeeks - 1; w >= 0; w--) {
    const target = latest.t - w * 7 * 24 * 60 * 60 * 1000;
    let best = pts[0];
    for (const pt of pts) {
      if (Math.abs(pt.t - target) < Math.abs(best.t - target)) best = pt;
    }
    buys.push({ at: new Date(best.t).toISOString().slice(0, 10), price: best.p, coins: amt / best.p });
  }
  const spent = amt * buys.length;
  const coins = buys.reduce((s, b) => s + b.coins, 0);
  const priceNow = latest.p;
  const priceFirst = buys[0].price;
  const valueNow = coins * priceNow;
  const avgPrice = coins > 0 ? spent / coins : 0;
  const lumpCoins = priceFirst > 0 ? spent / priceFirst : 0;
  const lumpValue = lumpCoins * priceNow;
  return {
    ok: true,
    asset: a,
    amount: amt,
    weeksRequested: nWeeks,
    weeksUsed: buys.length,
    spent,
    coins,
    avgPrice,
    priceFirst,
    priceNow,
    valueNow,
    vsSpent: valueNow - spent,
    lumpValue,
    vsLump: valueNow - lumpValue,
    firstBuyAt: buys[0].at,
    lastPriceAt: new Date(latest.t).toISOString().slice(0, 10),
    spark: buys.map((b) => +b.price.toPrecision(6)),
    source: prices.source,
    sourceUrl: prices.sourceUrl || 'https://www.coingecko.com',
    fetchedAt: prices.fetchedAt,
    note: 'Simulated from daily USD prices (' + prices.source + '), sampled once a week. This is a historical price path, not a 1Click quote, and it does not include swap fees or slippage.',
  };
}
