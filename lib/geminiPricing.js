// Gemini pricing (paid tier) for estimating AI cost from token counts.
// Prices are USD per 1,000,000 tokens. These are ESTIMATES — update them here if
// Google changes pricing. Cost is derived at query time from stored token counts,
// so editing these prices re-prices history too (no data migration needed).
//
// MYR conversion uses MYR_PER_USD from the environment (default 4.70).

const PRICES = {
  // model: { in: <usd per 1M input>, out: <usd per 1M output> }
  'gemini-2.5-flash':      { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'gemini-2.5-pro':        { in: 1.25, out: 10.00 },
  'gemini-2.0-flash':      { in: 0.10, out: 0.40 },
};
const FALLBACK = { in: 0.30, out: 2.50 }; // unknown model → treat as 2.5-flash

function priceFor(model) {
  return PRICES[model] || FALLBACK;
}

// USD cost for a given model + token split.
function costUsd(model, promptTokens = 0, outputTokens = 0) {
  const p = priceFor(model);
  return (Number(promptTokens) / 1e6) * p.in + (Number(outputTokens) / 1e6) * p.out;
}

function myrPerUsd() {
  const v = Number(process.env.MYR_PER_USD);
  return Number.isFinite(v) && v > 0 ? v : 4.70;
}

function costMyr(model, promptTokens = 0, outputTokens = 0) {
  return costUsd(model, promptTokens, outputTokens) * myrPerUsd();
}

module.exports = { PRICES, priceFor, costUsd, costMyr, myrPerUsd };
