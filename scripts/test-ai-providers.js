// Tests for provider routing and Claude content translation. No network calls.
// Run: node scripts/test-ai-providers.js
const assert = require('assert');
const { PROVIDERS, providerForModel } = require('../lib/aiModels');
const claude = require('../lib/claude');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log('AI provider routing');

test('every model maps back to exactly one provider', () => {
  const seen = new Map();
  for (const [key, p] of Object.entries(PROVIDERS)) {
    for (const m of p.models) {
      assert.ok(!seen.has(m), `${m} is listed under both ${seen.get(m)} and ${key}`);
      seen.set(m, key);
      assert.strictEqual(providerForModel(m), key);
    }
  }
});

test('each provider default is in its own model list', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.models.includes(p.defaultModel), `${key} default ${p.defaultModel} not in its list`);
  }
});

test('an unknown or empty model has no provider', () => {
  assert.strictEqual(providerForModel('gpt-4'), null);
  assert.strictEqual(providerForModel(''), null);
  assert.strictEqual(providerForModel(null), null);
  assert.strictEqual(providerForModel(undefined), null);
});

test('claude models route to claude, gemini to gemini', () => {
  assert.strictEqual(providerForModel('claude-opus-5-5'), 'claude');
  assert.strictEqual(providerForModel('claude-haiku-5-5'), 'claude');
  assert.strictEqual(providerForModel('gemini-2.5-flash'), 'gemini');
});

test('every provider declares the env var holding its key', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.envKey && /^[A-Z0-9_]+$/.test(p.envKey), `${key} has no usable envKey`);
  }
});

console.log('\nClaude content translation');

const b64 = Buffer.from('x').toString('base64');

test('a PDF becomes a document block, before the prompt text', () => {
  const content = claude.toContent([
    { text: 'Read this invoice' },
    { inlineData: { mimeType: 'application/pdf', data: b64 } }
  ]);
  assert.strictEqual(content.length, 2);
  assert.strictEqual(content[0].type, 'document', 'attachment must come first');
  assert.strictEqual(content[0].source.media_type, 'application/pdf');
  assert.strictEqual(content[1].type, 'text');
});

test('an image becomes an image block', () => {
  const content = claude.toContent([
    { text: 'Read this' },
    { inlineData: { mimeType: 'image/jpeg', data: b64 } }
  ]);
  assert.strictEqual(content[0].type, 'image');
  assert.strictEqual(content[0].source.media_type, 'image/jpeg');
});

test('HEIC is rejected with an actionable message, not a raw 400', () => {
  assert.throws(
    () => claude.toContent([{ inlineData: { mimeType: 'image/heic', data: b64 } }]),
    /Claude cannot read image\/heic.*Gemini/s
  );
});

test('text-only parts work (the no-attachment path)', () => {
  const content = claude.toContent([{ text: 'hello' }]);
  assert.deepStrictEqual(content, [{ type: 'text', text: 'hello' }]);
});

test('blank text parts are dropped', () => {
  assert.strictEqual(claude.toContent([{ text: '   ' }, { text: 'real' }]).length, 1);
});

test('model ids outside the list fall back to the default', () => {
  assert.strictEqual(claude.modelOrDefault('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.strictEqual(claude.modelOrDefault('gemini-2.5-flash'), claude.DEFAULT_MODEL);
  assert.strictEqual(claude.modelOrDefault(undefined), claude.DEFAULT_MODEL);
});

test('isConfigured follows ANTHROPIC_API_KEY', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = '';
    assert.strictEqual(claude.isConfigured(), false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    assert.strictEqual(claude.isConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  }
});

test('isUnavailableError: capacity/billing/network errors trigger Gemini fallback', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    for (const status of [429, 529, 503, 401]) {
      assert.ok(claude.isUnavailableError(Object.assign(new Error('x'), { status })), `status ${status}`);
    }
    assert.ok(claude.isUnavailableError(Object.assign(new Error('Your credit balance is too low'), { status: 400 })));
    assert.ok(claude.isUnavailableError(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })));
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  }
});

test('isUnavailableError: document problems do NOT fall back', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    assert.ok(!claude.isUnavailableError(new Error('Claude declined to process this document.')));
    assert.ok(!claude.isUnavailableError(new Error('This document is too long for claude-sonnet-5-5')));
    assert.ok(!claude.isUnavailableError(Object.assign(new Error('invalid request: bad image'), { status: 400 })));
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  }
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
