// Gemini token usage records (ai_usage). One row per AI call. Cost is NOT stored
// — it's derived from token counts + the price table (lib/geminiPricing) at query
// time, so price changes re-price history automatically.
const db = require('../db');

// Best-effort insert — never throw into the request/processing path. If the table
// doesn't exist yet (pre-migration) or the DB hiccups, we just skip recording.
async function record({ accountId = null, model = null, purpose = null, promptTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
  try {
    await db.execute(
      `INSERT INTO ai_usage (account_id, model, purpose, prompt_tokens, output_tokens, total_tokens)
       VALUES (?,?,?,?,?,?)`,
      [accountId, model, purpose,
       Number(promptTokens) || 0, Number(outputTokens) || 0,
       Number(totalTokens) || ((Number(promptTokens) || 0) + (Number(outputTokens) || 0))]
    );
  } catch (err) {
    console.error('[ai-usage] record skipped:', err.message);
  }
}

// Token totals grouped by month + model for the last 12 months (account-scoped).
function monthlyByModel(accountId) {
  return db.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, model,
            SUM(prompt_tokens) AS pin, SUM(output_tokens) AS pout, SUM(total_tokens) AS ttl
       FROM ai_usage
      WHERE account_id = ?
        AND created_at >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 11 MONTH), '%Y-%m-01')
      GROUP BY ym, model`,
    [accountId]
  );
}

// All-time token totals grouped by model (account-scoped).
function totalsByModel(accountId) {
  return db.query(
    `SELECT model, SUM(prompt_tokens) AS pin, SUM(output_tokens) AS pout, SUM(total_tokens) AS ttl
       FROM ai_usage WHERE account_id = ? GROUP BY model`,
    [accountId]
  );
}

module.exports = { record, monthlyByModel, totalsByModel };
