// Claude (Anthropic) provider — the alternative to Gemini for reading bills.
//
// Deliberately narrow: this module only knows how to send content to Claude and
// hand back raw text + token usage. Prompt building, JSON repair, bill shaping
// and usage recording all stay in server.js, exactly where the Gemini path
// keeps them, so switching provider changes the transport and nothing else.
//
// Key: ANTHROPIC_API_KEY in .env.
const Anthropic = require('@anthropic-ai/sdk');

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-opus-5-5';

// Claude reads these directly. HEIC is NOT among them (Gemini accepts it), so a
// HEIC photo is rejected with a clear message rather than a raw 400.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// A refused request stops dead unless a fallback is declared. Opus 5.5 and
// Sonnet 5.5 support the server-side form, which re-runs the same request on a
// fallback model inside the same call; Haiku 5.5 has none.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

function isConfigured() {
  return Boolean(apiKey());
}

function modelOrDefault(model) {
  return MODELS.includes(model) ? model : DEFAULT_MODEL;
}

let client = null;
function getClient() {
  if (!isConfigured()) throw new Error('Missing ANTHROPIC_API_KEY in .env.');
  if (!client) client = new Anthropic({ apiKey: apiKey() });
  return client;
}

// Gemini-shaped parts → Claude content blocks. Documents and images go FIRST:
// Claude reads an attachment better when the instructions follow it.
function toContent(parts) {
  const media = [];
  const text = [];
  for (const part of parts || []) {
    if (part && typeof part.text === 'string') {
      if (part.text.trim()) text.push({ type: 'text', text: part.text });
      continue;
    }
    const inline = part && part.inlineData;
    if (!inline || !inline.data) continue;
    const mime = String(inline.mimeType || '').toLowerCase();
    if (mime === 'application/pdf') {
      media.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: inline.data }
      });
    } else if (IMAGE_TYPES.includes(mime)) {
      media.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: inline.data }
      });
    } else {
      throw new Error(
        `Claude cannot read ${mime || 'this file type'} — it accepts PDF, JPEG, PNG, GIF and WebP. `
        + `Switch this account's AI model back to Gemini, or ask the sender to resend as a PDF or JPG.`
      );
    }
  }
  return [...media, ...text];
}

// One Claude call → { text, usage, stopReason }.
//
// Streams because a long invoice can run to tens of thousands of output tokens:
// a non-streaming request that size risks an HTTP timeout, and a timeout mid-
// extraction is indistinguishable from a truncated bill.
async function generate({
  parts, model, system = '', maxTokens = 64000, effort = 'medium',
  history = [], allowTruncation = false
}) {
  const useModel = modelOrDefault(model);
  const content = toContent(parts);
  if (!content.length) throw new Error('Nothing to send to Claude (empty prompt).');

  const request = {
    model: useModel,
    max_tokens: maxTokens,
    // Thinking is always on for these models and cannot be disabled; effort is
    // the only depth control. Left at medium: extraction is structured reading,
    // not open-ended reasoning.
    output_config: { effort },
    messages: [
      // Real turns, not a flattened transcript — Claude follows a conversation
      // far better when the roles are actual roles.
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '')
      })).filter((m) => m.content.trim()),
      { role: 'user', content }
    ]
  };
  if (system) request.system = system;
  if (FALLBACK_MODELS.has(useModel)) {
    request.betas = [FALLBACK_BETA];
    request.fallbacks = 'default';
  }

  const api = getClient();
  const stream = request.betas
    ? api.beta.messages.stream(request)
    : api.messages.stream(request);
  const message = await stream.finalMessage();

  // A policy refusal returns HTTP 200 with no usable content — check before reading.
  if (message.stop_reason === 'refusal') {
    const detail = message.stop_details || {};
    throw new Error(
      `Claude declined to process this document${detail.category ? ` (${detail.category})` : ''}. `
      + `Switch this account's AI model to Gemini for this bill.`
    );
  }
  // Truncated output means the line items after the cut simply are not there.
  // A bill whose items disagree with the paper is worse than no bill at all, so
  // extraction refuses rather than returning a stump (same rule as the Gemini
  // path). Chat passes allowTruncation — a clipped sentence is fine there.
  if (message.stop_reason === 'max_tokens' && !allowTruncation) {
    throw new Error(
      `This document is too long for ${useModel} — the extraction was cut off at its ${maxTokens}-token `
      + `output limit, so some line items are missing. Please send the invoice in smaller parts.`
    );
  }

  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('');

  const usage = message.usage || {};
  return {
    text,
    stopReason: message.stop_reason,
    model: message.model || useModel,
    usage: {
      // Cache reads/writes are input tokens too — count them so cost is not
      // under-reported once caching is in play.
      promptTokens: (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0),
      outputTokens: usage.output_tokens || 0
    }
  };
}

module.exports = { MODELS, DEFAULT_MODEL, isConfigured, modelOrDefault, generate, toContent };
