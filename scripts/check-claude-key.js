// Confirms ANTHROPIC_API_KEY works before any real bill is routed to Claude.
// Makes two small live calls (a few hundredths of a cent):
//   1. plain text  — is the key valid and the model reachable?
//   2. a 1-page PDF — does the document path work end to end?
//
// Run: node scripts/check-claude-key.js [model]
require('dotenv').config();
const claude = require('../lib/claude');

const model = process.argv[2] || claude.DEFAULT_MODEL;

// Smallest valid one-page PDF, with a line of text on it.
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R' +
  '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 54>>stream\nBT /F1 14 Tf 20 50 Td (INVOICE TOTAL 42.00) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Root 1 0 R>>\n', 'latin1');

async function main() {
  if (!claude.isConfigured()) {
    console.error('✗ ANTHROPIC_API_KEY is not set in .env — paste your key there first.');
    process.exit(1);
  }
  if (!claude.MODELS.includes(model)) {
    console.error(`✗ Unknown model "${model}". Available: ${claude.MODELS.join(', ')}`);
    process.exit(1);
  }
  console.log(`Checking ${model}…\n`);

  console.log('1/2  plain text request');
  const text = await claude.generate({
    model,
    maxTokens: 64,
    effort: 'low',
    parts: [{ text: 'Reply with exactly: OK' }]
  });
  console.log(`     reply: ${JSON.stringify(text.text.trim())}`);
  console.log(`     tokens: ${text.usage.promptTokens} in / ${text.usage.outputTokens} out\n`);

  console.log('2/2  PDF document request');
  const pdf = await claude.generate({
    model,
    maxTokens: 256,
    effort: 'low',
    parts: [
      { text: 'What total does this document show? Answer with just the number.' },
      { inlineData: { mimeType: 'application/pdf', data: TINY_PDF.toString('base64') } }
    ]
  });
  console.log(`     reply: ${JSON.stringify(pdf.text.trim())}`);
  console.log(`     tokens: ${pdf.usage.promptTokens} in / ${pdf.usage.outputTokens} out\n`);

  const pricing = require('../lib/aiPricing');
  const totalIn = text.usage.promptTokens + pdf.usage.promptTokens;
  const totalOut = text.usage.outputTokens + pdf.usage.outputTokens;
  console.log(`✓ ${model} is working. This check cost about `
    + `USD ${pricing.costUsd(model, totalIn, totalOut).toFixed(4)} `
    + `(MYR ${pricing.costMyr(model, totalIn, totalOut).toFixed(4)}).`);
  console.log('\nSet it per account in the admin page: Account → AI model → ' + model);
}

main().catch((err) => {
  console.error(`\n✗ Failed: ${err.message}`);
  if (/beta|fallback/i.test(err.message)) {
    console.error('\n  This mentions the server-side fallback beta. If your account does not have it,');
    console.error('  remove the `request.betas` / `request.fallbacks` lines in lib/claude.js and retry.');
  }
  if (err.status === 401) console.error('\n  401 means the key itself was rejected — check for a stray space in .env.');
  process.exit(1);
});
