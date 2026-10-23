// runtime/usage.js — what an engagement cost, and what that number is allowed to claim.
//
// The bill has one shape and one set of rules, whichever surface shows it:
//
//   · every provider call adds tokens, a request, and — when a price exists — an amount
//     into the bucket that produced it: `provider` (the endpoint reported it), `declared`
//     (the profile's price table) or `unattributed` (a legacy figure whose source was
//     never recorded). A call with no price increments `unpriced_requests` instead;
//   · a sum may only be presented as a bill when every call in it was priced. Otherwise
//     the amount is a floor, and `costText`/`costShort`/`costBadge` say so in words;
//   · unknown is not zero: `known` is false when nothing was priced, so no surface can
//     render a `$0.00` that looks measured.
//
// Pure: no fs, no network, no environment. `runtime/session-state.js` persists what these
// functions compute (one file per session); `tools/console/chat.js` keeps the same shape in
// its own conversation store; the terminal prints it. Because the rules and the formatting
// live here, those surfaces cannot disagree about an amount or its label.

'use strict';

// ── the rollup ─────────────────────────────────────────────────────────────
// Three buckets, so the source is never lost, plus a count of calls that could not be
// priced at all: that count is what turns a total into a floor, and it is why the view
// below carries `partial` rather than leaving each surface to infer it.
const COST_BUCKETS = ['provider', 'declared', 'unattributed'];
const pos = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function emptyUsage() {
  return {
    version: 1,
    requests: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost: { provider: 0, declared: 0, unattributed: 0 },
    unpriced_requests: 0,
  };
}

// Tolerates everything older states can contain: a missing block, part of one, or the
// pre-rollup `cost: 0.004` number (kept, but as `unattributed` — its source was never
// recorded, and inventing one would be the bug this module exists to avoid).
function normalizeUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const out = emptyUsage();
  out.requests = pos(u.requests);
  out.tokens_in = pos(u.tokens_in);
  out.tokens_out = pos(u.tokens_out);
  out.unpriced_requests = pos(u.unpriced_requests);
  const c = u.cost;
  if (c && typeof c === 'object') {
    for (const k of COST_BUCKETS) out.cost[k] = pos(c[k]);
  } else if (c != null && Number.isFinite(Number(c)) && Number(c) > 0) {
    out.cost.unattributed = Number(c);
  }
  return out;
}

// One provider call. `source` is 'provider' | 'declared' | null; `cost` must be a real
// amount (0 is a real amount: a free tier is priced at zero, not unknown).
function addUsage(rollup, sample = {}) {
  const r = normalizeUsage(rollup);
  r.requests += 1;
  r.tokens_in += pos(sample.tokens_in);
  r.tokens_out += pos(sample.tokens_out);
  const hasCost = sample.cost !== null && sample.cost !== undefined
    && Number.isFinite(Number(sample.cost)) && Number(sample.cost) >= 0;
  if (hasCost) {
    const bucket = COST_BUCKETS.includes(sample.source) ? sample.source : 'unattributed';
    r.cost[bucket] += Number(sample.cost);
  } else {
    r.unpriced_requests += 1;
  }
  return r;
}

// Precision chosen from the magnitude, so a cheap run is not $0.00 and an expensive one
// is not a wall of decimals: 2 / 3 / 5 / 6 places as the amount shrinks.
function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$?';
  const abs = Math.abs(v);
  if (abs === 0) return '$0';
  // Dollars keep the conventional two places; below a dollar the trailing zeros are
  // dropped, so a rate of $0.0042 is not dressed up as $0.00420 (a precision the number
  // does not have) while still never rounding to $0.00.
  const trimmed = (places) => v.toFixed(places).replace(/0+$/, '').replace(/\.$/, '');
  if (abs >= 1) return '$' + v.toFixed(2);
  if (abs >= 0.01) return '$' + trimmed(3);
  if (abs >= 0.0001) return '$' + trimmed(5);
  return '$' + trimmed(6);
}

// The single description of a rollup. `known` means at least one call was priced;
// `partial` means some were not, so `amount` is a floor and every surface must say it.
function costView(rollup) {
  const u = normalizeUsage(rollup);
  const amount = u.cost.provider + u.cost.declared + u.cost.unattributed;
  const pricedCalls = Math.max(0, u.requests - u.unpriced_requests);
  const sources = [];
  if (u.cost.provider > 0) sources.push('provider-reported');
  if (u.cost.declared > 0) sources.push('declared prices');
  if (u.cost.unattributed > 0) sources.push('source unrecorded');
  return {
    amount,
    // A recorded amount is itself evidence something was priced, even in a legacy shape
    // that never counted its calls: the display then reports the amount without a source.
    known: pricedCalls > 0 || amount > 0,
    partial: u.unpriced_requests > 0,
    unpriced: u.unpriced_requests,
    requests: u.requests,
    pricedCalls,
    sources,
    tokens_in: u.tokens_in,
    tokens_out: u.tokens_out,
  };
}

// The cost sentence, with no number invented when there is none. It starts with the word a
// surface would otherwise print as a label (`cost    ${costText}`), so it says "unknown",
// not "cost unknown".
function costText(view) {
  if (!view.known) {
    if (!view.requests) return 'unknown (no usage recorded)';
    return `unknown (${view.requests} call(s), no price reported or declared)`;
  }
  const bits = [formatMoney(view.amount)];
  if (view.sources.length) bits.push(view.sources.join(' + '));
  if (view.partial) bits.push(`${view.unpriced} call(s) unpriced — a floor, not the bill`);
  return bits.join(' · ');
}

// Short form for a status line: a known total, with `+` when it is a floor.
function costShort(view) {
  if (!view.known) return 'cost unknown';
  return formatMoney(view.amount) + (view.partial ? '+' : '');
}

// The badge a surface prints next to tokens, source included. It lives here, with the
// other formatting, because two surfaces (the terminal and the console chat) show the
// same number and a second implementation is how they start disagreeing about its label.
function costBadge(view) {
  if (!view.known) return 'cost unknown';
  const declaredOnly = view.sources.length === 1 && view.sources[0] === 'declared prices';
  return costShort(view) + (declaredOnly ? ' (declared)' : '');
}

module.exports = {
  COST_BUCKETS,
  emptyUsage,
  normalizeUsage,
  addUsage,
  formatMoney,
  costView,
  costText,
  costShort,
  costBadge,
};
