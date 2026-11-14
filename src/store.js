const PLAN_PREFIX = 'plan:';
const HIST_PREFIX = 'hist:';
const TOKENS_KEY = 'cache:tokens';

export async function putPlan(env, plan) {
  await env.PLANS.put(PLAN_PREFIX + plan.id, JSON.stringify(plan));
  return plan;
}

export async function getPlan(env, id) {
  const raw = await env.PLANS.get(PLAN_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

export async function listPlans(env) {
  const plans = [];
  let cursor;
  do {
    const page = await env.PLANS.list({ prefix: PLAN_PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.PLANS.get(k.name);
      if (raw) plans.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return plans;
}

export async function getHistory(env, id) {
  const raw = await env.PLANS.get(HIST_PREFIX + id);
  return raw ? JSON.parse(raw) : [];
}

export async function appendHistory(env, id, event, cap = 200) {
  const list = await getHistory(env, id);
  list.unshift(event);
  if (list.length > cap) list.length = cap;
  await env.PLANS.put(HIST_PREFIX + id, JSON.stringify(list));
  return list;
}

export async function cachedTokens(env, fetcher, ttlMs = 10 * 60 * 1000) {
  const raw = await env.PLANS.get(TOKENS_KEY);
  if (raw) {
    try {
      const { at, tokens } = JSON.parse(raw);
      if (Array.isArray(tokens) && Date.now() - at < ttlMs) return tokens;
    } catch {}
  }
  const tokens = await fetcher();
  await env.PLANS.put(TOKENS_KEY, JSON.stringify({ at: Date.now(), tokens }), { expirationTtl: 60 * 30 });
  return tokens;
}
