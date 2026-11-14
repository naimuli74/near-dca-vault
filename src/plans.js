import { TARGETS, EVM_CHAINS, amountToUnits, findToken } from './oneclick.js';

export const INTERVALS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

export function newId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function looksEvm(a) { return /^0x[a-fA-F0-9]{40}$/.test(a || ''); }
export function looksNear(a) {
  const s = (a || '').toLowerCase();
  return /^([a-z0-9_-]{2,64}\.)*([a-z0-9_-]{2,64})\.near$/.test(s) || /^[a-f0-9]{64}$/.test(s);
}
export function looksBtc(a) {
  return /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a || '');
}
export function looksSol(a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || ''); }

export function validateAddress(chain, address, role) {
  const a = (address || '').trim();
  if (!a) throw new Error(`${role} address is required`);
  if (chain === 'btc') {
    if (!looksBtc(a)) throw new Error(`${role} must be a Bitcoin address (bc1…, 1… or 3…)`);
  } else if (chain === 'near') {
    if (!looksNear(a)) throw new Error(`${role} must be a NEAR account (name.near or a 64-character implicit id)`);
  } else if (chain === 'sol') {
    if (!looksSol(a)) throw new Error(`${role} must be a Solana address`);
  } else if (EVM_CHAINS.has(chain) || (chain || '').length <= 8) {
    if (looksEvm(a)) return a;
    if (chain === 'ton' || chain === 'tron' || chain === 'stellar' || chain === 'sui' || chain === 'aptos') {
      if (a.length < 8) throw new Error(`${role} address looks too short for ${chain}`);
      return a;
    }
    if (!looksEvm(a)) throw new Error(`${role} must be a 0x address on ${chain}`);
  }
  return a;
}

export function fundsLocation(status, plan) {
  const dest = plan?.destinationSymbol || 'the destination asset';
  const refund = plan?.refundTo || 'your refund address';
  const recipient = plan?.recipient || 'your destination address';
  switch (status) {
    case 'PENDING_DEPOSIT':
      return {
        status,
        where: 'Your wallet, until you send',
        detail: 'A wet quote is waiting. Send the exact USDC amount to the 1Click deposit address. Until you send, funds stay in your wallet. The deposit address expires in about 10 minutes and cannot be reused for a later buy.',
      };
    case 'KNOWN_DEPOSIT_TX':
      return {
        status,
        where: '1Click deposit address',
        detail: 'Your deposit was seen on the origin chain. Funds are at the quote-specific deposit address, waiting to be swapped.',
      };
    case 'PROCESSING':
      return {
        status,
        where: 'In flight on NEAR Intents',
        detail: 'The swap is being executed. Funds are moving from the deposit address toward your destination through NEAR Intents solvers.',
      };
    case 'SUCCESS':
      return {
        status,
        where: recipient,
        detail: `${dest} was delivered to your destination address. 1Click does not hold the funds.`,
      };
    case 'REFUNDED':
      return {
        status,
        where: refund,
        detail: 'The swap failed and funds were returned to your refund address.',
      };
    case 'FAILED':
      return {
        status,
        where: 'Check the refund address',
        detail: 'The swap encountered an error. Check your refund address and the Intents explorer. The app never takes custody.',
      };
    case 'INCOMPLETE_DEPOSIT':
      return {
        status,
        where: 'Deposit address (short deposit)',
        detail: 'A deposit arrived but was below the quoted amount. Do not send a second payment to this address. Wait for a refund or a new quote.',
      };
    case 'SKIPPED_SLIPPAGE':
      return {
        status,
        where: 'Your wallet (nothing moved)',
        detail: 'The quote was worse than your slippage limit after known fees, so this interval was skipped. No deposit address was used.',
      };
    case 'DRY_QUOTED':
      return {
        status,
        where: 'Your wallet (dry-run)',
        detail: 'This was a real 1Click quote with dry: true. No deposit address was issued and no funds moved.',
      };
    default:
      return {
        status: status || 'IDLE',
        where: 'Your wallet',
        detail: 'No swap is in flight. In dry-run, funds never leave your wallet. In live mode, you send each interval yourself to a fresh 1Click deposit address.',
      };
  }
}

export function validatePlanInput(body, tokens) {
  const mode = body.mode === 'live' ? 'live' : 'dry';
  const origin = findToken(tokens, body.originAsset);
  if (!origin || (origin.symbol || '').toUpperCase() !== 'USDC') {
    throw new Error('Choose a USDC asset from the supported token list');
  }
  const targetKey = (body.target || '').toUpperCase();
  const target = TARGETS[targetKey];
  if (!target) throw new Error('Target must be BTC, ETH or NEAR');
  const dest = findToken(tokens, target.assetId) || target;
  const interval = body.interval || '1d';
  if (!INTERVALS[interval]) throw new Error('Interval must be 5m, 15m, 1h, 1d or 1w');
  const slippageBps = Number(body.slippageBps ?? 100);
  if (!Number.isFinite(slippageBps) || slippageBps < 10 || slippageBps > 1000) {
    throw new Error('Slippage limit must be between 10 and 1000 basis points');
  }
  const recipient = validateAddress(target.chain, body.recipient, 'Destination');
  const refundTo = validateAddress(origin.blockchain, body.refundTo, 'Refund');
  const amountHuman = String(body.amountHuman || body.amount || '').trim();
  const amount = body.amount && /^\d+$/.test(String(body.amount))
    ? String(body.amount)
    : amountToUnits(amountHuman, origin.decimals);
  const maxBuys = body.maxBuys == null || body.maxBuys === '' ? null : Number(body.maxBuys);
  if (maxBuys != null && (!Number.isInteger(maxBuys) || maxBuys < 1 || maxBuys > 365)) {
    throw new Error('Max buys must be between 1 and 365, or left empty');
  }
  return {
    mode,
    originAsset: origin.assetId,
    originChain: origin.blockchain,
    originSymbol: origin.symbol,
    originDecimals: origin.decimals,
    destinationAsset: target.assetId,
    destinationChain: target.chain,
    destinationSymbol: dest.symbol || target.symbol,
    target: targetKey,
    amount,
    amountHuman: amountHuman || String(Number(amount) / 10 ** origin.decimals),
    recipient,
    refundTo,
    slippageBps,
    interval,
    maxBuys,
  };
}

export function createPlan(body, tokens) {
  const v = validatePlanInput(body, tokens);
  const now = Date.now();
  return {
    id: newId(),
    createdAt: new Date(now).toISOString(),
    ...v,
    buysDone: 0,
    skipped: 0,
    nextDueAt: new Date(now + (INTERVALS[v.interval] || INTERVALS['1d'])).toISOString(),
    lastBuyAt: null,
    paused: false,
    pending: null,
  };
}

export function isDue(plan, now = Date.now()) {
  if (plan.paused) return false;
  if (plan.maxBuys != null && plan.buysDone >= plan.maxBuys) return false;
  return new Date(plan.nextDueAt).getTime() <= now;
}

export function advancePlan(plan, now = Date.now()) {
  const step = INTERVALS[plan.interval] || INTERVALS['1d'];
  let next = Math.max(now, new Date(plan.nextDueAt).getTime()) + step;
  plan.nextDueAt = new Date(next).toISOString();
  plan.lastBuyAt = new Date(now).toISOString();
  return plan;
}

export function planOpen(plan) {
  if (plan.paused) return false;
  if (plan.maxBuys != null && plan.buysDone >= plan.maxBuys) return false;
  return true;
}
