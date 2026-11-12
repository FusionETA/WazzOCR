// The catalogue of AI models the app can route a bill to, shared by server.js
// (which adds the API-key checks) and admin/router.js (which derives an
// account's provider from the model it was given).
//
// An account stores only `ai_model`; `ai_provider` is derived from it with
// providerForModel, so a model can never be paired with the wrong API.
const claude = require('./claude');

const PROVIDERS = {
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    helpText: 'Groq uses the OpenAI-compatible chat completions API.',
    envKey: 'GROQ_API_KEY',
    models: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.1-8b-instant'
    ]
  },
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-2.5-flash',
    helpText: "Gemini uses Google's generateContent API.",
    envKey: 'GEMINI_API_KEY',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash'
    ]
  },
  claude: {
    label: 'Claude',
    defaultModel: claude.DEFAULT_MODEL,
    helpText: 'Claude reads PDFs and images directly. Needs ANTHROPIC_API_KEY in .env.',
    envKey: 'ANTHROPIC_API_KEY',
    models: claude.MODELS
  }
};

// Which provider owns a model id, or null when the id is unknown.
function providerForModel(model) {
  const id = String(model || '');
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (provider.models.includes(id)) return key;
  }
  return null;
}

module.exports = { PROVIDERS, providerForModel };
