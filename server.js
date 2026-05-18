const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.set('trust proxy', true);
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 3000);
const APP_ROOT = __dirname;
const DATA_DIR = path.join(APP_ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TOKEN_FILE = path.join(DATA_DIR, 'xero-tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'xero-auth-state.json');
const BILLS_FILE = path.join(DATA_DIR, 'bills.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending-bills.json');
const AI_SETTINGS_FILE = path.join(DATA_DIR, 'ai-settings.json');
const BILL_STATUS_CRON_LOG_FILE = path.join(DATA_DIR, 'bill-status-cron.log');
const WHATSAPP_STATE_FILE = path.join(DATA_DIR, 'whatsapp-state.json');
const XERO_IDENTITY_BASE = 'https://login.xero.com/identity/connect';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const FALLBACK_SUPPLIER_NAME = 'ImportWazzOCR Supplier';

const {
  XERO_CLIENT_ID,
  XERO_CLIENT_SECRET,
  XERO_REDIRECT_URI = `http://localhost:${PORT}/api/xero/callback`,
  PUBLIC_APP_URL = '',
  XERO_SCOPES = 'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings',
  XERO_DEFAULT_ACCOUNT_CODE = '',
  XERO_DEFAULT_TAX_TYPE = 'NONE',
  XERO_DEFAULT_CURRENCY = 'MYR',
  GROQ_API_KEY = '',
  GEMINI_API_KEY = '',
  DEFAULT_AI_PROVIDER = 'groq',
  WHATSAPP_AUTO_CREATE_XERO_BILLS = 'false',
  BILL_STATUS_CRON_SECRET = ''
} = process.env;

const AI_PROVIDERS = {
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    helpText: 'Groq uses the OpenAI-compatible chat completions API.',
    models: [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.1-8b-instant'
    ],
    hasKey: () => Boolean(GROQ_API_KEY)
  },
  gemini: {
    label: 'Gemini',
    defaultModel: 'gemini-2.5-flash',
    helpText: 'Gemini uses Google\'s generateContent API.',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash'
    ],
    hasKey: () => Boolean(GEMINI_API_KEY)
  }
};

function ensureConfig() {
  const missing = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Xero environment config: ${missing.join(', ')}`);
  }
}

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function ensureUploadDir() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await ensureDataDir();
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
}

function basicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function urlEncode(body) {
  return new URLSearchParams(body).toString();
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function getRequestOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = (forwardedProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getOAuthRedirectUri(req) {
  const requestOrigin = normalizeBaseUrl(getRequestOrigin(req));
  const requestHostname = (() => {
    try {
      return new URL(requestOrigin).hostname;
    } catch {
      return '';
    }
  })();

  if (isLocalHost(requestHostname)) {
    return XERO_REDIRECT_URI || `${requestOrigin}/api/xero/callback`;
  }

  const publicBase = normalizeBaseUrl(PUBLIC_APP_URL);
  if (publicBase) {
    return `${publicBase}/api/xero/callback`;
  }

  return `${requestOrigin}/api/xero/callback`;
}

function toIsoExpiry(expiresInSeconds) {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function isTokenExpiringSoon(tokens) {
  if (!tokens?.expiresAt) return true;
  return Date.now() >= new Date(tokens.expiresAt).getTime() - 60_000;
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function getGrantIdentity(tokens = {}) {
  const claims = decodeJwtPayload(tokens.idToken);
  return {
    userId: tokens.userId || claims.sub || null,
    email: tokens.email || claims.email || null,
    name: tokens.name || claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || null
  };
}

function getConnectionTenantId(connection) {
  return connection?.tenantId || connection?.id || null;
}

function tenantBelongsToGrant(grant, tenantId) {
  return Boolean(tenantId && (grant.connections || []).some((c) => getConnectionTenantId(c) === tenantId));
}

function buildGrantId(tokens, connections) {
  const identity = getGrantIdentity(tokens);
  if (identity.userId) return `user:${identity.userId}`;
  if (identity.email) return `email:${identity.email.toLowerCase()}`;
  const tenantIds = (connections || []).map(getConnectionTenantId).filter(Boolean).sort().join('|');
  return `grant:${crypto.createHash('sha256').update(`${tenantIds}:${tokens.refreshToken || ''}`).digest('hex').slice(0, 16)}`;
}

function normalizeTokenGrant(tokens = {}, connections = tokens.connections || [], existing = {}) {
  const identity = getGrantIdentity(tokens);
  const now = isoNow();
  return {
    ...existing,
    id: existing.id || buildGrantId(tokens, connections),
    userId: identity.userId,
    email: identity.email,
    name: identity.name,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    scope: tokens.scope,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
    connections: Array.isArray(connections) ? connections : [],
    createdAt: existing.createdAt || tokens.createdAt || tokens.updatedAt || now,
    updatedAt: now
  };
}

async function loadTokenStore() {
  const saved = await readJson(TOKEN_FILE, null);
  if (!saved) {
    return { grants: [], updatedAt: isoNow() };
  }
  if (Array.isArray(saved.grants)) {
    return {
      ...saved,
      grants: saved.grants.filter((grant) => grant?.refreshToken || grant?.accessToken)
    };
  }
  if (saved.refreshToken || saved.accessToken) {
    return {
      grants: [normalizeTokenGrant(saved, saved.connections || [])],
      updatedAt: saved.updatedAt || isoNow(),
      migratedFromLegacy: true
    };
  }
  return { grants: [], updatedAt: isoNow() };
}

async function saveTokenStore(store) {
  await writeJson(TOKEN_FILE, {
    grants: store.grants || [],
    updatedAt: isoNow()
  });
}

function mergeGrantConnections(grants) {
  const byTenant = new Map();
  for (const grant of grants || []) {
    for (const connection of grant.connections || []) {
      const tenantId = getConnectionTenantId(connection);
      if (!tenantId) continue;
      const previous = byTenant.get(tenantId);
      if (!previous || String(grant.updatedAt || '') >= String(previous.grantUpdatedAt || '')) {
        byTenant.set(tenantId, {
          ...connection,
          tenantId,
          grantId: grant.id,
          connectedBy: grant.email || grant.name || grant.userId || null,
          grantUpdatedAt: grant.updatedAt || null
        });
      }
    }
  }
  return [...byTenant.values()].sort((a, b) => String(a.tenantName || '').localeCompare(String(b.tenantName || '')));
}

function normalizeDateString(value) {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function normalizeNumber(value, fallback = 0) {
  const cleaned = typeof value === 'string'
    ? value.replace(/,/g, '').replace(/[^\d.-]/g, '')
    : value;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : fallback;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function safeEquals(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function escapeXeroString(value) {
  return String(value).replace(/"/g, '\\"');
}

function buildWhereClause(parts) {
  return parts.filter(Boolean).join('&&');
}

function getFirstItem(payload, key) {
  const list = payload?.[key];
  return Array.isArray(list) && list.length ? list[0] : null;
}

const NON_BLOCKING_BILL_STATUSES = new Set(['DELETED', 'VOIDED']);
const ARCHIVED_BILL_STATUSES = new Set(['DELETED', 'VOIDED', 'MISSING', 'NOT_FOUND']);

function isBlockingDuplicateBill(invoice) {
  if (!invoice?.InvoiceID) return false;
  const status = String(invoice.Status || '').toUpperCase();
  return !NON_BLOCKING_BILL_STATUSES.has(status);
}

function isArchivedBillStatus(status) {
  return ARCHIVED_BILL_STATUSES.has(String(status || '').toUpperCase());
}

function isArchivedBillRecord(record) {
  return Boolean(record?.archivedAt || isArchivedBillStatus(record?.status));
}

function collectValidationMessages(node, messages = [], seen = new Set()) {
  if (!node || typeof node !== 'object') {
    return messages;
  }

  if (Array.isArray(node.ValidationErrors)) {
    for (const item of node.ValidationErrors) {
      if (item?.Message && !seen.has(item.Message)) {
        seen.add(item.Message);
        messages.push(item.Message);
      }
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        collectValidationMessages(child, messages, seen);
      }
    } else if (value && typeof value === 'object') {
      collectValidationMessages(value, messages, seen);
    }
  }

  return messages;
}

function formatXeroError(payload, fallbackStatus) {
  if (fallbackStatus === 401 || payload?.Detail === 'AuthorizationUnsuccessful') {
    return 'Xero authorization failed. Please reconnect Xero.';
  }

  const validationMessages = collectValidationMessages(payload);
  if (validationMessages.length) {
    return `Xero validation failed: ${validationMessages.join(' | ')}`;
  }

  return (
    payload?.Detail ||
    payload?.Message ||
    `Xero request failed (${fallbackStatus})`
  );
}

// ── File storage helpers ────────────────────────────────────────────────────

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf'
};

function mimeToExt(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || '.bin';
}

async function saveUploadedBuffer(buffer, mime) {
  await ensureUploadDir();
  const id = crypto.randomUUID();
  const filename = `${id}${mimeToExt(mime)}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

async function readUploadedFile(filename) {
  return fsp.readFile(path.join(UPLOAD_DIR, filename));
}

async function deleteUploadedFile(filename) {
  if (!filename) return;
  try {
    await fsp.unlink(path.join(UPLOAD_DIR, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to delete uploaded file ${filename}:`, error.message);
    }
  }
}

// ── Persistent stores: bills, pending, AI settings ──────────────────────────

async function loadBills() {
  return (await readJson(BILLS_FILE, [])) || [];
}

async function saveBillRecord(record) {
  const list = await loadBills();
  list.unshift(record);
  await writeJson(BILLS_FILE, list);
  return record;
}

async function saveBills(list) {
  await writeJson(BILLS_FILE, list);
}

async function logBillStatusCron(entry) {
  await ensureDataDir();
  await fsp.appendFile(BILL_STATUS_CRON_LOG_FILE, `${JSON.stringify(entry)}\n`);
}

async function loadPendingBills() {
  return (await readJson(PENDING_FILE, [])) || [];
}

async function getPendingBill(id) {
  const list = await loadPendingBills();
  return list.find((item) => item.id === id) || null;
}

async function appendPendingBill(record) {
  const list = await loadPendingBills();
  list.unshift(record);
  await writeJson(PENDING_FILE, list);
  return record;
}

async function removePendingBill(id) {
  const list = await loadPendingBills();
  const idx = list.findIndex((item) => item.id === id);
  if (idx === -1) return null;
  const [removed] = list.splice(idx, 1);
  await writeJson(PENDING_FILE, list);
  return removed;
}

async function loadAiSettings() {
  const stored = await readJson(AI_SETTINGS_FILE, null);
  if (stored?.provider && AI_PROVIDERS[stored.provider]) {
    const validModels = AI_PROVIDERS[stored.provider].models;
    return {
      provider: stored.provider,
      model: validModels.includes(stored.model) ? stored.model : AI_PROVIDERS[stored.provider].defaultModel
    };
  }
  const fallback = AI_PROVIDERS[DEFAULT_AI_PROVIDER] ? DEFAULT_AI_PROVIDER : 'groq';
  return { provider: fallback, model: AI_PROVIDERS[fallback].defaultModel };
}

async function saveAiSettings({ provider, model }) {
  if (!AI_PROVIDERS[provider]) {
    throw new Error(`Unknown AI provider: ${provider}`);
  }
  const validModels = AI_PROVIDERS[provider].models;
  const final = {
    provider,
    model: validModels.includes(model) ? model : AI_PROVIDERS[provider].defaultModel
  };
  await writeJson(AI_SETTINGS_FILE, final);
  return final;
}

// ── Tenant matching: Malaysia-aware multi-strategy scorer ───────────────────
//
// Strategies (highest scoring wins, ties → ambiguous → null):
//   exact (after normalization)               score 100
//   prefix containment (one starts with other) 95
//   parenthetical-initials  e.g. (SP) ↔ Sri Petaling
//                                              92
//   substring containment                      88
//   all-tokens-contained (shorter ⊂ longer)    82
//   Levenshtein distance 1                     78
//   Levenshtein distance 2 (on long strings)   72
//   token Jaccard ≥ 0.7                        65
//
// Threshold to accept: 70. Ambiguous if top two scores tie within 3 points.

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const prev = new Array(al + 1);
  const curr = new Array(al + 1);
  for (let j = 0; j <= al; j++) prev[j] = j;

  for (let i = 1; i <= bl; i++) {
    curr[0] = i;
    for (let j = 1; j <= al; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= al; j++) prev[j] = curr[j];
  }
  return prev[al];
}

// Malaysian + common business legal suffixes. These are LEGAL FORM markers only —
// we deliberately do NOT include brand-meaningful words like "Holdings", "Group",
// "Services", "Trading" because those are part of the company's identity, not its
// legal form, and stripping them collapses distinct companies.
// Order matters — longer/more-specific tokens first so "sdn bhd" is stripped as a unit.
const COMPANY_SUFFIX_TOKENS = [
  'sendirian berhad', 'sdn bhd', 'sendirian bhd', 'sdn berhad',
  'berhad', 'bhd',
  'pte ltd', 'private limited', 'pte ltd.',
  'limited', 'ltd',
  'plt', 'llp',
  'corporation', 'corp',
  'incorporated', 'inc',
  'gmbh',
  'company'
];

// Words that introduce a "care of" / forwarding party — anything after these
// is NOT part of the billed entity's identity.
const CARE_OF_MARKERS = [
  /\s+c\/o\s+.*$/i,
  /\s+c\\o\s+.*$/i,
  /\s+care\s+of\s+.*$/i,
  /\s+attn:?\s+.*$/i,
  /\s+attention:?\s+.*$/i,
  /\s+a\/c\s+.*$/i        // "A/C" (account) lines
];

function stripCareOf(name) {
  let s = name;
  for (const re of CARE_OF_MARKERS) s = s.replace(re, '');
  return s.trim();
}

// Light normalization — for comparison only. Preserves parenthetical groups so
// we can detect abbreviations like "(SP)" separately.
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[,]/g, ' ')
    .replace(/\./g, '')         // drop periods (sdn. bhd. → sdn bhd)
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Heavier normalization — strips care-of, parenthetical abbreviations, and
// trailing legal/business suffix tokens. Used as the "core identity" form.
function normalizeCompanyCore(value) {
  let s = normalizeName(value);
  s = stripCareOf(s);
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();   // drop "( ... )" groups
  s = s.replace(/[()]/g, ' ').trim();

  // Strip trailing suffix tokens iteratively (handles "abc sdn bhd plt")
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of COMPANY_SUFFIX_TOKENS) {
      const re = new RegExp(`(?:^|\\s)${suf.replace(/\s+/g, '\\s+')}\\s*$`, 'i');
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

function tokenize(s) {
  return String(s || '').split(/\s+/).filter(Boolean);
}

function initialsOf(s) {
  return tokenize(s).map((t) => t[0] || '').join('');
}

// Extract a trailing parenthetical group, e.g. "ayu borneo (sp)" → { core: "ayu borneo", abbrev: "sp" }
function extractParentheticalAbbrev(normalized) {
  const m = String(normalized || '').match(/^(.*?)\s*\(([a-z0-9]+)\)\s*$/i);
  if (!m) return { core: normalized, abbrev: null };
  return { core: m[1].trim(), abbrev: m[2].toLowerCase() };
}

function scoreMatch(billRaw, tenantRaw) {
  const billNorm = normalizeName(billRaw);
  const tenantNorm = normalizeName(tenantRaw);
  if (!billNorm || !tenantNorm) return { score: 0, reason: 'empty' };

  const billCore = normalizeCompanyCore(billRaw);
  const tenantCore = normalizeCompanyCore(tenantRaw);

  // Strongest signals first on the "core" identity (suffixes stripped).
  if (billCore && tenantCore && billCore === tenantCore) {
    return { score: 100, reason: 'exact-core' };
  }
  if (billNorm === tenantNorm) {
    return { score: 100, reason: 'exact-norm' };
  }

  // Prefix containment on core (handles "Ayu Borneo Sdn Bhd c/o ABC" → "Ayu Borneo")
  if (billCore && tenantCore) {
    if (billCore.startsWith(tenantCore + ' ') || tenantCore.startsWith(billCore + ' ')) {
      return { score: 95, reason: 'prefix-core' };
    }
  }
  if (billNorm.startsWith(tenantNorm + ' ') || tenantNorm.startsWith(billNorm + ' ')) {
    return { score: 95, reason: 'prefix-norm' };
  }

  // Parenthetical-initials match: "Ayu Borneo (SP)" ↔ "Ayu Borneo Sri Petaling"
  const billPar = extractParentheticalAbbrev(billNorm);
  const tenPar = extractParentheticalAbbrev(tenantNorm);
  const checkAbbrev = (abbrev, abbrevCore, otherFull) => {
    if (!abbrev || !abbrevCore || !otherFull) return false;
    const otherCore = normalizeCompanyCore(otherFull);
    const acCore = normalizeCompanyCore(abbrevCore);
    if (!otherCore.startsWith(acCore)) return false;
    const rest = otherCore.slice(acCore.length).trim();
    if (!rest) return false;
    const initials = initialsOf(rest).toLowerCase();
    // Direct initials, or contiguous prefix of initials (rare but safe)
    return initials === abbrev || initials.startsWith(abbrev);
  };
  if (checkAbbrev(billPar.abbrev, billPar.core, tenantRaw)) {
    return { score: 92, reason: 'parenthetical-initials' };
  }
  if (checkAbbrev(tenPar.abbrev, tenPar.core, billRaw)) {
    return { score: 92, reason: 'parenthetical-initials' };
  }

  // Substring containment on core
  if (billCore && tenantCore) {
    if (billCore.includes(tenantCore) || tenantCore.includes(billCore)) {
      return { score: 88, reason: 'substring-core' };
    }
  }

  // All tokens of the shorter side are present in the longer side (handles
  // word-order shuffles and missing/extra middle words within reason).
  const billTokens = tokenize(billCore || billNorm);
  const tenantTokens = tokenize(tenantCore || tenantNorm);
  if (billTokens.length && tenantTokens.length) {
    const [shorter, longer] = billTokens.length <= tenantTokens.length
      ? [billTokens, tenantTokens] : [tenantTokens, billTokens];
    if (shorter.length >= 2 && shorter.every((t) => longer.includes(t))) {
      return { score: 82, reason: 'all-tokens-contained' };
    }
  }

  // Typo tolerance via Levenshtein on the core identity.
  const dist = levenshtein(billCore || billNorm, tenantCore || tenantNorm);
  const maxLen = Math.max((billCore || billNorm).length, (tenantCore || tenantNorm).length);
  if (dist <= 1) return { score: 78, reason: 'lev-1' };
  if (dist <= 2 && maxLen >= 10) return { score: 72, reason: 'lev-2' };

  // Token Jaccard similarity as a last-resort fuzzy signal.
  const setA = new Set(billTokens);
  const setB = new Set(tenantTokens);
  if (setA.size && setB.size) {
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    const union = new Set([...setA, ...setB]).size;
    const jaccard = union ? inter / union : 0;
    if (jaccard >= 0.7) return { score: 65, reason: `jaccard-${jaccard.toFixed(2)}` };
    return { score: Math.round(jaccard * 50), reason: `weak-${jaccard.toFixed(2)}` };
  }

  return { score: 0, reason: 'none' };
}

const MATCH_ACCEPT_THRESHOLD = 70;
const MATCH_AMBIGUOUS_MARGIN = 3;

function matchTenantByName(billedTo, tenants) {
  if (!billedTo || !Array.isArray(tenants) || !tenants.length) return null;
  const normBill = normalizeName(billedTo);
  if (!normBill) return null;

  // ── Pre-pass 1: parenthetical abbreviation disambiguation ────────────────
  // If the bill name has a trailing "(XX)" group, prefer the tenant whose
  // expanded suffix initials match XX. This overrides the otherwise-tied
  // "Ayu Borneo" base form when bill says "Ayu Borneo (SP)".
  const billPar = extractParentheticalAbbrev(normBill);
  if (billPar.abbrev) {
    const abbrevCore = normalizeCompanyCore(billPar.core);
    const abbrevHits = tenants.filter((t) => {
      const tCore = normalizeCompanyCore(t.tenantName);
      if (!tCore.startsWith(abbrevCore + ' ')) return false;
      const rest = tCore.slice(abbrevCore.length).trim();
      if (!rest) return false;
      const initials = initialsOf(rest).toLowerCase();
      return initials === billPar.abbrev || initials.startsWith(billPar.abbrev);
    });
    if (abbrevHits.length === 1) return abbrevHits[0];
    // If multiple expand to the same initials we fall through to scoring,
    // which will most likely flag it as ambiguous → null.
  }

  const scored = tenants
    .map((t) => ({ tenant: t, ...scoreMatch(billedTo, t.tenantName) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MATCH_ACCEPT_THRESHOLD) return null;

  const second = scored[1];
  if (second && (best.score - second.score) < MATCH_AMBIGUOUS_MARGIN) {
    return null; // ambiguous
  }
  return best.tenant;
}

// Expose for unit testing without changing public behaviour.
function _debugScoreMatch(billedTo, tenantName) {
  return scoreMatch(billedTo, tenantName);
}

// ── Xero OAuth & API ────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code, redirectUri) {
  const response = await fetch(`${XERO_IDENTITY_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(XERO_CLIENT_ID, XERO_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: urlEncode({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Xero token exchange failed (${response.status})`);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    scope: payload.scope,
    tokenType: payload.token_type,
    expiresAt: toIsoExpiry(payload.expires_in),
    updatedAt: isoNow()
  };
}

async function refreshTokens(saved) {
  const response = await fetch(`${XERO_IDENTITY_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(XERO_CLIENT_ID, XERO_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: urlEncode({
      grant_type: 'refresh_token',
      refresh_token: saved.refreshToken
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Xero token refresh failed (${response.status})`);
  }

  const next = {
    ...saved,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || saved.refreshToken,
    idToken: payload.id_token || saved.idToken,
    scope: payload.scope || saved.scope,
    tokenType: payload.token_type || saved.tokenType,
    expiresAt: toIsoExpiry(payload.expires_in),
    updatedAt: isoNow()
  };

  return next;
}

async function fetchConnections(accessToken) {
  const response = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.detail || `Failed to fetch Xero connections (${response.status})`);
  }
  return payload;
}

async function getTokensForTenant(tenantId, { refreshIfNeeded = true } = {}) {
  ensureConfig();
  const store = await loadTokenStore();
  let grants = store.grants || [];
  let changed = Boolean(store.migratedFromLegacy);
  const candidates = grants.filter((grant) => tenantBelongsToGrant(grant, tenantId));

  for (const grant of candidates.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))) {
    try {
      let current = grant;
      if (refreshIfNeeded && isTokenExpiringSoon(current)) {
        current = await refreshTokens(current);
        const idx = grants.findIndex((item) => item.id === grant.id);
        if (idx !== -1) {
          grants[idx] = normalizeTokenGrant(current, current.connections || [], grants[idx]);
          changed = true;
        }
      }
      if (changed) await saveTokenStore({ grants });
      return current;
    } catch (error) {
      console.error(`Could not refresh Xero token for tenant ${tenantId}:`, error.message);
    }
  }

  if (changed) await saveTokenStore({ grants });
  return null;
}

async function getValidConnections() {
  let store = await loadTokenStore();
  let grants = store.grants || [];
  let changed = Boolean(store.migratedFromLegacy);

  if (!grants.length) {
    return { tokens: null, grants: [], connections: [] };
  }

  const activeGrants = [];
  const persistedGrants = [];
  for (const grant of grants) {
    try {
      const fresh = isTokenExpiringSoon(grant) ? await refreshTokens(grant) : grant;
      const connections = await fetchConnections(fresh.accessToken);
      const nextGrant = normalizeTokenGrant(fresh, connections, grant);
      activeGrants.push(nextGrant);
      persistedGrants.push(nextGrant);
      if (JSON.stringify(nextGrant) !== JSON.stringify(grant)) changed = true;
    } catch (error) {
      console.error('Could not refresh Xero connections for saved grant:', error.message);
      persistedGrants.push(grant);
    }
  }

  if (changed) {
    grants = persistedGrants;
    await saveTokenStore({ grants });
  } else {
    grants = persistedGrants;
  }

  return {
    tokens: activeGrants[0] || null,
    grants: activeGrants,
    connections: mergeGrantConnections(activeGrants)
  };
}

async function xeroApi(pathname, { method = 'GET', body, headers = {}, raw = false } = {}, tenantId) {
  if (!tenantId) {
    throw new Error('tenantId is required for Xero API calls.');
  }
  const tokens = await getTokensForTenant(tenantId);
  if (!tokens?.accessToken) {
    const error = new Error('Xero is not connected to this organisation yet.');
    error.statusCode = 401;
    throw error;
  }

  const response = await fetch(`${XERO_API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
      ...headers
    },
    body
  });

  if (raw) {
    if (!response.ok) {
      const text = await response.text();
      let message;
      try {
        const errorPayload = JSON.parse(text);
        message = formatXeroError(errorPayload, response.status);
      } catch {
        message = text || `Xero request failed (${response.status})`;
      }
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    return response;
  }

  const payload = await response.json();
  if (!response.ok) {
    const message = formatXeroError(payload, response.status);
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

// ── Xero bill creation (per-tenant) ─────────────────────────────────────────

async function findOrCreateContact(bill, tenantId) {
  const supplierName = String(bill.supplier || FALLBACK_SUPPLIER_NAME).trim() || FALLBACK_SUPPLIER_NAME;

  const exactWhere = buildWhereClause([
    `Name=="${escapeXeroString(supplierName)}"`,
    'ContactStatus=="ACTIVE"'
  ]);
  const contactsPayload = await xeroApi(`/Contacts?where=${encodeURIComponent(exactWhere)}`, {}, tenantId);
  const existing = getFirstItem(contactsPayload, 'Contacts');
  if (existing?.ContactID) {
    return existing;
  }

  const createdPayload = await xeroApi('/Contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Contacts: [{ Name: supplierName }]
    })
  }, tenantId);

  const created = getFirstItem(createdPayload, 'Contacts');
  if (!created?.ContactID) {
    throw new Error('Xero did not return a contact after creation.');
  }
  return created;
}

async function findDuplicateBill(invoiceNumber, tenantId) {
  if (!invoiceNumber) return null;
  const where = buildWhereClause([
    'Type=="ACCPAY"',
    `InvoiceNumber=="${escapeXeroString(invoiceNumber)}"`,
    'Status!="DELETED"',
    'Status!="VOIDED"'
  ]);
  const payload = await xeroApi(`/Invoices?where=${encodeURIComponent(where)}`, {}, tenantId);
  return (payload.Invoices || []).find(isBlockingDuplicateBill) || null;
}

function deriveLineItems(bill, defaults) {
  const provided = Array.isArray(bill.lineItems) ? bill.lineItems : [];
  const accountCode = bill.accountCode || defaults.accountCode || null;
  const taxType = bill.taxType || defaults.taxType || null;

  if (!provided.length && normalizeNumber(bill.total) > 0) {
    const lineItem = {
      Description: `Receipt total${bill.invoiceNo ? ` for ${bill.invoiceNo}` : ''}`,
      Quantity: 1,
      UnitAmount: normalizeNumber(bill.total)
    };
    if (accountCode) lineItem.AccountCode = accountCode;
    if (taxType) lineItem.TaxType = taxType;
    return [lineItem];
  }

  const normalized = provided.map((item, index) => {
    const quantity = normalizeNumber(firstPresent(item.qty, item.quantity, item.Quantity), 1) || 1;
    const amount = normalizeNumber(firstPresent(item.amount, item.lineAmount, item.LineAmount, item.total, item.Total), 0);
    const unitPrice = normalizeNumber(
      firstPresent(item.unitPrice, item.unitAmount, item.UnitAmount, item.price, item.rate),
      amount > 0 ? amount / quantity : 0
    );
    const resolvedAccount = item.accountCode || accountCode;
    const resolvedTax = item.taxType || taxType;
    const lineItem = {
      Description: String(firstPresent(item.description, item.Description, item.name) || `Line item ${index + 1}`),
      Quantity: quantity,
      UnitAmount: Number(unitPrice.toFixed(2))
    };
    if (resolvedAccount) lineItem.AccountCode = resolvedAccount;
    if (resolvedTax) lineItem.TaxType = resolvedTax;
    if (amount > 0) lineItem.LineAmount = Number(amount.toFixed(2));
    return lineItem;
  }).filter((item) => item.UnitAmount > 0 || item.LineAmount > 0);

  if (!normalized.length) {
    throw new Error('No usable line items were found for the bill.');
  }

  return normalized;
}

async function createDraftBill({ bill, sourceFile, tenantId }) {
  if (!tenantId) {
    throw new Error('tenantId is required.');
  }
  bill.supplier = String(bill.supplier || '').trim() || FALLBACK_SUPPLIER_NAME;
  const contact = await findOrCreateContact(bill, tenantId);
  const duplicate = await findDuplicateBill(bill.invoiceNo, tenantId);
  if (duplicate?.InvoiceID) {
    const error = new Error(`An active bill with invoice number "${bill.invoiceNo}" already exists in Xero.`);
    error.statusCode = 409;
    error.payload = {
      duplicate: true,
      invoiceId: duplicate.InvoiceID,
      invoiceNumber: duplicate.InvoiceNumber,
      status: duplicate.Status,
      contactName: duplicate.Contact?.Name || null
    };
    throw error;
  }

  const lineItems = deriveLineItems(bill, {
    accountCode: XERO_DEFAULT_ACCOUNT_CODE,
    taxType: XERO_DEFAULT_TAX_TYPE
  });

  const invoicePayload = {
    Invoices: [
      {
        Type: 'ACCPAY',
        Status: 'DRAFT',
        Contact: { ContactID: contact.ContactID },
        DateString: normalizeDateString(bill.date),
        DueDateString: normalizeDateString(bill.dueDate),
        InvoiceNumber: bill.invoiceNo || undefined,
        CurrencyCode: bill.currency || XERO_DEFAULT_CURRENCY,
        Reference: bill.notes || undefined,
        LineAmountTypes: 'Exclusive',
        LineItems: lineItems
      }
    ]
  };

  const createdPayload = await xeroApi('/Invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invoicePayload)
  }, tenantId);

  let invoice = getFirstItem(createdPayload, 'Invoices');
  if (!invoice?.InvoiceID) {
    throw new Error('Xero did not return an invoice after creation.');
  }

  try {
    const freshInvoice = await fetchXeroBill(invoice.InvoiceID, tenantId);
    if (freshInvoice?.InvoiceID) {
      invoice = { ...invoice, ...freshInvoice };
    }
  } catch (error) {
    console.error(`Could not refresh created Xero bill ${invoice.InvoiceID}:`, error.message);
  }

  let attachment = null;
  if (sourceFile?.buffer?.length) {
    const safeName = (sourceFile.originalname || 'receipt-upload').replace(/[^a-zA-Z0-9._-]/g, '-');
    await xeroApi(`/Invoices/${invoice.InvoiceID}/Attachments/${encodeURIComponent(safeName)}?IncludeOnline=true`, {
      method: 'POST',
      headers: {
        'Content-Type': sourceFile.mimetype || 'application/octet-stream'
      },
      body: sourceFile.buffer,
      raw: true
    }, tenantId);
    attachment = { fileName: safeName };
  }

  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber || bill.invoiceNo || null,
    status: invoice.Status,
    contactName: invoice.Contact?.Name || contact.Name,
    total: invoice.Total,
    currency: invoice.CurrencyCode || bill.currency || XERO_DEFAULT_CURRENCY,
    dueDate: invoice.DueDateString || normalizeDateString(bill.dueDate) || null,
    url: invoice.Url || `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${invoice.InvoiceID}`,
    attachment
  };
}

function buildBillRecord({ bill, result, tenant, source }) {
  return {
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName || null,
    billedTo: bill.billedTo || null,
    supplier: bill.supplier || null,
    invoiceNo: bill.invoiceNo || result.invoiceNumber || null,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber || bill.invoiceNo || null,
    status: result.status,
    total: result.total,
    currency: result.currency,
    xeroUrl: result.url || `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${result.invoiceId}`,
    attachmentName: result.attachment?.fileName || null,
    source: source || 'manual',
    createdAt: isoNow()
  };
}

async function fetchXeroBill(invoiceId, tenantId) {
  const payload = await xeroApi(`/Invoices/${encodeURIComponent(invoiceId)}`, {}, tenantId);
  return getFirstItem(payload, 'Invoices');
}

// Fetch attachment metadata for a Xero invoice (no binaries).
async function listXeroInvoiceAttachments(invoiceId, tenantId) {
  const payload = await xeroApi(`/Invoices/${encodeURIComponent(invoiceId)}/Attachments`, {}, tenantId);
  return Array.isArray(payload?.Attachments) ? payload.Attachments : [];
}

// Download a single attachment by file name (Xero's documented retrieval path).
async function downloadXeroInvoiceAttachment(invoiceId, fileName, tenantId) {
  const response = await xeroApi(
    `/Invoices/${encodeURIComponent(invoiceId)}/Attachments/${encodeURIComponent(fileName)}`,
    { headers: { Accept: '*/*' }, raw: true },
    tenantId
  );
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Soft-delete a DRAFT bill by flipping its Status to DELETED. Only valid for DRAFT
// invoices — Xero will reject this on AUTHORISED/SUBMITTED/PAID, which is exactly
// the safety net we want (reassign is restricted to DRAFTs upstream).
async function deleteDraftXeroBill(invoiceId, tenantId) {
  const payload = {
    Invoices: [{ InvoiceID: invoiceId, Status: 'DELETED' }]
  };
  return xeroApi(`/Invoices/${encodeURIComponent(invoiceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, tenantId);
}

// Rebuild a "bill payload" (the shape createDraftBill consumes) from a freshly
// fetched Xero invoice + the local record. We re-derive line items from Xero so
// the new draft is an exact copy, not a summary.
function reconstructBillFromXeroInvoice(invoice, fallbackRecord) {
  const lineItems = Array.isArray(invoice?.LineItems)
    ? invoice.LineItems.map((li) => ({
        description: li.Description || '',
        qty: Number(li.Quantity) || 1,
        unitPrice: Number(li.UnitAmount) || 0,
        amount: Number(li.LineAmount) || 0,
        accountCode: li.AccountCode || null,
        taxType: li.TaxType || null
      }))
    : [];

  return normalizeBillPayload({
    supplier: invoice?.Contact?.Name || fallbackRecord?.supplier || null,
    billedTo: fallbackRecord?.billedTo || null,
    invoiceNo: invoice?.InvoiceNumber || fallbackRecord?.invoiceNumber || fallbackRecord?.invoiceNo || null,
    date: invoice?.DateString || invoice?.Date || null,
    dueDate: invoice?.DueDateString || invoice?.DueDate || null,
    currency: invoice?.CurrencyCode || fallbackRecord?.currency || XERO_DEFAULT_CURRENCY,
    lineItems,
    subtotal: Number(invoice?.SubTotal) || 0,
    tax: Number(invoice?.TotalTax) || 0,
    taxLabel: 'Tax',
    discount: 0,
    total: Number(invoice?.Total) || 0,
    notes: invoice?.Reference || null
  });
}

function applyXeroBillStatus(record, invoice, checkedAt) {
  const status = String(invoice?.Status || record.status || 'UNKNOWN').toUpperCase();
  const next = {
    ...record,
    invoiceNumber: invoice?.InvoiceNumber || record.invoiceNumber || record.invoiceNo,
    status,
    total: invoice?.Total ?? record.total,
    currency: invoice?.CurrencyCode || record.currency,
    xeroUrl: invoice?.Url || record.xeroUrl,
    lastStatusCheckedAt: checkedAt,
    statusCheckError: null
  };

  if (isArchivedBillStatus(status)) {
    next.archivedAt = record.archivedAt || checkedAt;
    next.archiveReason = `Xero status ${status}`;
  } else {
    delete next.archivedAt;
    delete next.archiveReason;
  }

  return next;
}

function markBillMissing(record, checkedAt, reason = 'Invoice not found in Xero') {
  return {
    ...record,
    status: 'MISSING',
    archivedAt: record.archivedAt || checkedAt,
    archiveReason: reason,
    lastStatusCheckedAt: checkedAt,
    statusCheckError: null
  };
}

async function refreshStoredBillStatuses({ tenantId = null } = {}) {
  const checkedAt = isoNow();
  const bills = await loadBills();
  let checked = 0;
  let updated = 0;
  const errors = [];

  const nextBills = [];
  for (const record of bills) {
    if (tenantId && record.tenantId !== tenantId) {
      nextBills.push(record);
      continue;
    }
    if (!record.invoiceId || !record.tenantId) {
      nextBills.push(record);
      continue;
    }

    checked += 1;
    try {
      const invoice = await fetchXeroBill(record.invoiceId, record.tenantId);
      const next = invoice
        ? applyXeroBillStatus(record, invoice, checkedAt)
        : markBillMissing(record, checkedAt);
      if (JSON.stringify(next) !== JSON.stringify(record)) updated += 1;
      nextBills.push(next);
    } catch (error) {
      if (error.statusCode === 404 || /not\s*found|cannot\s*find|does\s*not\s*exist/i.test(error.message || '')) {
        const next = markBillMissing(record, checkedAt, error.message || 'Invoice not found in Xero');
        if (JSON.stringify(next) !== JSON.stringify(record)) updated += 1;
        nextBills.push(next);
        continue;
      }

      errors.push({
        id: record.id,
        invoiceId: record.invoiceId,
        tenantId: record.tenantId,
        error: error.message
      });
      nextBills.push({
        ...record,
        lastStatusCheckedAt: checkedAt,
        statusCheckError: error.message
      });
    }
  }

  if (updated || errors.length) {
    await saveBills(nextBills);
  }

  return {
    ok: errors.length === 0,
    checked,
    updated,
    archived: nextBills.filter(isArchivedBillRecord).length,
    active: nextBills.filter((bill) => !isArchivedBillRecord(bill)).length,
    errors
  };
}

// ── AI bill analysis ────────────────────────────────────────────────────────

function buildBillPrompt(ocrText) {
  return `You are an expert at reading bills, receipts and invoices from OCR-extracted text.

CONTEXT — Malaysian business invoices:
- Most billed entities are Malaysian companies. Common legal suffixes:
    * "Sdn Bhd" (Sendirian Berhad) — private limited
    * "Bhd" (Berhad) — public limited
    * "PLT" — limited liability partnership
    * "Enterprise" / "Trading" — sole proprietor / partnership
- "c/o" (care of) means the bill is forwarded through someone else.
  The actual BILLED ENTITY is the company BEFORE "c/o" — extract only that.
  Example: "Ayu Borneo Sdn Bhd c/o XYZ Office" → billedTo = "Ayu Borneo Sdn Bhd"
- Place names are often abbreviated in parentheses (these abbreviations
  matter — preserve them as-is so they can be reconciled with the
  organisation list). Examples:
    * (SP) = Sri Petaling     * (KL) = Kuala Lumpur
    * (PJ) = Petaling Jaya    * (JB) = Johor Bahru
    * (KK) = Kota Kinabalu    * (KCH) = Kuching
- Default currency is MYR. Common tax label is "SST" (Sales & Service Tax,
  typically 6% or 8%). Older invoices may say "GST".
- Dates may be formatted DD/MM/YYYY or DD-MM-YYYY (day first, NOT US format).

EXTRACTION RULES:
- Always extract the billedTo as the FULL company name as it appears in the
  document (keep "Sdn Bhd", "(SP)", etc.). Do NOT shorten, expand or rewrite it.
- If multiple addresses/branches appear, pick the one in the BILL TO / TO /
  SOLD TO / INVOICE TO block, not the supplier's address.

Given the raw OCR text below, extract and return ONLY a valid JSON object:
{
  "supplier": "Vendor / supplier company name (the company sending the invoice) or null",
  "billedTo": "Customer / recipient company name (look for BILL TO, TO, SOLD TO, INVOICE TO sections). Full name as written; if c/o present, only the entity BEFORE c/o.",
  "invoiceNo": "Invoice number or null",
  "date": "Date string or null",
  "dueDate": "Due date string or null",
  "currency": "MYR/USD/SGD etc, default MYR",
  "lineItems": [{ "description": "string", "qty": 1, "unitPrice": 0.00, "amount": 0.00 }],
  "subtotal": 0.00,
  "tax": 0.00,
  "taxLabel": "SST/GST/VAT/Tax",
  "discount": 0.00,
  "total": 0.00,
  "notes": "string or null"
}
Return ONLY valid JSON. All amounts as numbers. null for missing strings, 0 for missing numbers.

OCR Text:
${ocrText}`;
}

function extractJsonText(raw) {
  const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('The model did not return valid JSON.');
  }
  return cleaned.slice(start, end + 1);
}

function normalizeBillPayload(bill) {
  const lineItems = Array.isArray(bill?.lineItems)
    ? bill.lineItems.map((item) => {
        const qty = normalizeNumber(firstPresent(item.qty, item.quantity, item.Quantity), 1) || 1;
        const amount = normalizeNumber(firstPresent(item.amount, item.lineAmount, item.LineAmount, item.total, item.Total), 0);
        const unitPrice = normalizeNumber(
          firstPresent(item.unitPrice, item.unitAmount, item.UnitAmount, item.price, item.rate),
          amount > 0 ? amount / qty : 0
        );
        return {
          ...item,
          description: firstPresent(item.description, item.Description, item.name) || '',
          qty,
          unitPrice,
          amount
        };
      })
    : [];

  const normalized = {
    supplier: bill?.supplier || null,
    billedTo: bill?.billedTo || null,
    invoiceNo: bill?.invoiceNo || null,
    date: bill?.date || null,
    dueDate: bill?.dueDate || null,
    currency: bill?.currency || XERO_DEFAULT_CURRENCY,
    lineItems,
    subtotal: normalizeNumber(bill?.subtotal),
    tax: normalizeNumber(bill?.tax),
    taxLabel: bill?.taxLabel || 'Tax',
    discount: normalizeNumber(bill?.discount),
    total: normalizeNumber(bill?.total),
    notes: bill?.notes || null
  };

  if (!normalized.total && normalized.lineItems.length) {
    normalized.total = normalized.lineItems.reduce((sum, item) => sum + normalizeNumber(item.amount), 0);
  }
  if (!normalized.subtotal && normalized.total) {
    normalized.subtotal = Math.max(0, normalized.total - normalized.tax + normalized.discount);
  }
  return normalized;
}

async function callGroqBill(ocrText, model) {
  if (!GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY in .env.');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: model || AI_PROVIDERS.groq.defaultModel,
      messages: [{ role: 'user', content: buildBillPrompt(ocrText) }],
      temperature: 0.1,
      max_tokens: 1500
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Groq analysis failed (${response.status}).`);
  }

  return normalizeBillPayload(JSON.parse(extractJsonText(payload.choices?.[0]?.message?.content)));
}

async function callGeminiBill(ocrText, model) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in .env.');
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || AI_PROVIDERS.gemini.defaultModel)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: buildBillPrompt(ocrText) }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1500,
        response_mime_type: 'application/json'
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini analysis failed (${response.status}).`);
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return normalizeBillPayload(JSON.parse(extractJsonText(text)));
}

async function analyzeBillText({ text, provider, model }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('OCR text is required for AI analysis.');
  }
  const settings = await loadAiSettings();
  const useProvider = provider || settings.provider;
  const useModel = model || settings.model;

  const selectedProvider = AI_PROVIDERS[useProvider] ? useProvider : settings.provider;
  if (selectedProvider === 'gemini') {
    return callGeminiBill(trimmed, useModel);
  }
  return callGroqBill(trimmed, useModel);
}

// ── Tesseract OCR pipeline (replaces Gemini for WhatsApp file → text) ──────
//
// Inputs: a raw image buffer (image/*) OR a PDF buffer (application/pdf).
// PDFs are first rasterized one page at a time to PNG via pdf-to-png-converter,
// then each page is OCR'd with tesseract.js. Text from all pages is joined.

let _tesseractWorker = null;
async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  const Tesseract = require('tesseract.js');
  // 'eng' is enough for English / Malay Latin script. Add 'msa' here later
  // if you need a Malay language model — it requires downloading extra data.
  const worker = await Tesseract.createWorker('eng');
  _tesseractWorker = worker;
  return worker;
}

async function rasterizePdfToPngs(pdfBuffer) {
  const { pdfToPng } = require('pdf-to-png-converter');
  const pages = await pdfToPng(pdfBuffer, {
    viewportScale: 2.0, // 2x = ~144 DPI, balances OCR quality vs memory
    disableFontFace: true,
    useSystemFonts: false
  });
  return pages.map((p) => p.content); // array of Buffers (PNG)
}

async function runTesseractOcr(buffer, mime) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty file: nothing to OCR.');
  }
  const worker = await getTesseractWorker();
  const isPdf = String(mime || '').toLowerCase() === 'application/pdf'
    || buffer.slice(0, 4).toString() === '%PDF';

  const images = isPdf ? await rasterizePdfToPngs(buffer) : [buffer];
  if (!images.length) return '';

  const texts = [];
  for (let i = 0; i < images.length; i++) {
    const { data } = await worker.recognize(images[i]);
    const pageText = (data?.text || '').trim();
    if (pageText) {
      texts.push(images.length > 1 ? `─── Page ${i + 1} ───\n${pageText}` : pageText);
    }
  }
  return texts.join('\n\n');
}

// ── WhatsApp conversation state (per-chat picker / context) ─────────────────

async function loadWhatsappState() {
  return (await readJson(WHATSAPP_STATE_FILE, {})) || {};
}

async function saveWhatsappState(state) {
  await writeJson(WHATSAPP_STATE_FILE, state);
}

async function getChatState(chatId) {
  const all = await loadWhatsappState();
  return all[chatId] || null;
}

async function setChatState(chatId, patch) {
  const all = await loadWhatsappState();
  const current = all[chatId] || {};
  all[chatId] = { ...current, ...patch, updatedAt: isoNow() };
  await saveWhatsappState(all);
  return all[chatId];
}

async function clearChatState(chatId, key = null) {
  const all = await loadWhatsappState();
  if (!all[chatId]) return;
  if (key) {
    delete all[chatId][key];
    all[chatId].updatedAt = isoNow();
  } else {
    delete all[chatId];
  }
  await saveWhatsappState(all);
}

// ── Groq general chat (replaces Gemini chat for non-bill WhatsApp messages) ─

async function callGroqChat(userMessage, history = []) {
  if (!GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY in .env.');
  }
  const systemPrompt = `You are WazzOCR, FusionETA's friendly WhatsApp assistant for bookkeeping.

You help users:
- Process invoices/receipts they send as images or PDFs (auto-extracted to Xero drafts)
- Answer questions about their bills, Xero organisations, and bookkeeping basics
- Chat naturally in English, Malay (Bahasa Malaysia), or Chinese

Style: friendly, professional, very concise (this is WhatsApp). Keep replies under 6 short lines unless asked for detail. Use light WhatsApp markdown (*bold*, _italic_) sparingly.

Commands the user can type:
- "orgs" — list connected Xero organisations
- "pending" — list bills awaiting org assignment
- "help" — show what you can do

When asked who you are: "I'm WazzOCR by FusionETA — I read your invoices and post them to Xero."`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: userMessage }
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_PROVIDERS.groq.defaultModel,
      messages,
      temperature: 0.7,
      max_tokens: 600
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Groq chat failed (${response.status}).`);
  }
  return (payload.choices?.[0]?.message?.content || '').trim();
}

// ── WhatsApp processing core (shared by /process-file and resolver) ─────────

async function processBillForChat({ bill, attachment, chatId, source = 'whatsapp' }) {
  let connections = [];
  let xeroAvailable = false;
  try {
    const conn = await getValidConnections();
    connections = conn.connections;
    xeroAvailable = Boolean(conn.tokens?.accessToken);
  } catch (err) {
    console.error('Could not refresh Xero connections:', err.message);
  }

  const matchedTenant = matchTenantByName(bill.billedTo, connections);
  const candidatesList = connections.map((c) => ({
    tenantId: c.tenantId,
    tenantName: c.tenantName
  }));

  if (matchedTenant && xeroAvailable) {
    let sourceFile = null;
    if (attachment) {
      try {
        sourceFile = {
          buffer: await readUploadedFile(attachment.filename),
          mimetype: attachment.mime,
          originalname: attachment.originalName
        };
      } catch (err) {
        console.error('Could not read attachment for matched bill:', err.message);
      }
    }
    try {
      const result = await createDraftBill({
        bill,
        sourceFile,
        tenantId: matchedTenant.tenantId
      });
      await saveBillRecord(buildBillRecord({
        bill,
        result,
        tenant: matchedTenant,
        source
      }));
      if (attachment) {
        await deleteUploadedFile(attachment.filename);
      }
      // Matched → clear any picker state for this chat
      if (chatId) await clearChatState(chatId, 'awaitingPicker');
      return {
        status: 'created',
        bill,
        matchedTenant: { tenantId: matchedTenant.tenantId, tenantName: matchedTenant.tenantName },
        xero: { ...result, tenantId: matchedTenant.tenantId, tenantName: matchedTenant.tenantName },
        candidates: candidatesList
      };
    } catch (xeroError) {
      const pending = await appendPendingBill({
        id: crypto.randomUUID(),
        bill,
        billedTo: bill.billedTo,
        attachedFile: attachment,
        reason: `Auto-create failed in ${matchedTenant.tenantName}: ${xeroError.message}`,
        suggestedTenantId: matchedTenant.tenantId,
        candidates: candidatesList,
        source,
        createdAt: isoNow()
      });
      if (chatId) {
        await setChatState(chatId, {
          awaitingPicker: { pendingBillId: pending.id, candidates: candidatesList }
        });
      }
      return {
        status: 'pending',
        bill,
        matchedTenant: { tenantId: matchedTenant.tenantId, tenantName: matchedTenant.tenantName },
        pending: { id: pending.id, reason: pending.reason, candidates: candidatesList },
        candidates: candidatesList
      };
    }
  }

  if (xeroAvailable) {
    const pending = await appendPendingBill({
      id: crypto.randomUUID(),
      bill,
      billedTo: bill.billedTo,
      attachedFile: attachment,
      reason: 'No matching organisation found for "' + (bill.billedTo || '(empty BILL TO)') + '".',
      suggestedTenantId: null,
      candidates: candidatesList,
      source,
      createdAt: isoNow()
    });
    if (chatId) {
      await setChatState(chatId, {
        awaitingPicker: { pendingBillId: pending.id, candidates: candidatesList }
      });
    }
    return {
      status: 'pending',
      bill,
      matchedTenant: null,
      pending: { id: pending.id, reason: pending.reason, candidates: candidatesList },
      candidates: candidatesList
    };
  }

  // Xero not connected — return bill only
  return {
    status: 'no-xero',
    bill,
    matchedTenant: null,
    candidates: []
  };
}

async function resolvePickerForChat(chatId, choice) {
  const state = await getChatState(chatId);
  if (!state?.awaitingPicker?.pendingBillId) return null;

  const { pendingBillId, candidates } = state.awaitingPicker;
  let tenantId = null;

  // Numbered choice (1-based)
  const num = Number.parseInt(String(choice).trim(), 10);
  if (!Number.isNaN(num) && num >= 1 && num <= candidates.length) {
    tenantId = candidates[num - 1].tenantId;
  } else {
    // Match by tenantId directly, or fuzzy by name
    const choiceLc = String(choice).trim().toLowerCase();
    const byId = candidates.find((c) => c.tenantId === choice);
    if (byId) {
      tenantId = byId.tenantId;
    } else {
      const byName = candidates.find((c) =>
        String(c.tenantName || '').toLowerCase().includes(choiceLc) && choiceLc.length >= 3
      );
      if (byName) tenantId = byName.tenantId;
    }
  }
  if (!tenantId) return { resolved: false, reason: 'No matching choice' };

  const pending = await getPendingBill(pendingBillId);
  if (!pending) {
    await clearChatState(chatId, 'awaitingPicker');
    return { resolved: false, reason: 'Pending bill no longer exists' };
  }

  const { connections } = await getValidConnections();
  const tenant = connections.find((c) => c.tenantId === tenantId);
  if (!tenant) return { resolved: false, reason: 'Tenant not connected anymore' };

  let sourceFile = null;
  if (pending.attachedFile) {
    try {
      sourceFile = {
        buffer: await readUploadedFile(pending.attachedFile.filename),
        mimetype: pending.attachedFile.mime,
        originalname: pending.attachedFile.originalName
      };
    } catch (err) {
      console.error('Pending attachment missing on disk:', err.message);
    }
  }

  const result = await createDraftBill({
    bill: pending.bill,
    sourceFile,
    tenantId
  });
  await saveBillRecord(buildBillRecord({
    bill: pending.bill,
    result,
    tenant,
    source: pending.source ? `${pending.source}+whatsapp-picker` : 'whatsapp-picker'
  }));
  await removePendingBill(pendingBillId);
  if (pending.attachedFile) await deleteUploadedFile(pending.attachedFile.filename);
  await clearChatState(chatId, 'awaitingPicker');

  return {
    resolved: true,
    tenant: { tenantId: tenant.tenantId, tenantName: tenant.tenantName },
    xero: { ...result, tenantId: tenant.tenantId, tenantName: tenant.tenantName },
    bill: pending.bill
  };
}

// ── Express routes ──────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  const blocked = [
    /^\/\.env(?:$|\.)/,
    /^\/env\.js$/,
    /^\/data(?:\/|$)/,
    /^\/OCR-Xero(?:\/|$)/
  ];
  if (blocked.some((pattern) => pattern.test(req.path))) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(APP_ROOT));

app.get('/', (req, res) => {
  res.redirect('/index.html');
});

app.get('/xero-setup', (req, res) => {
  res.redirect('/index.html#settings');
});

// ── AI config & settings ────────────────────────────────────────────────────

app.get('/api/ai/config', (req, res) => {
  const providers = Object.fromEntries(
    Object.entries(AI_PROVIDERS).map(([key, provider]) => [
      key,
      {
        label: provider.label,
        defaultModel: provider.defaultModel,
        helpText: provider.helpText,
        models: provider.models,
        hasKey: provider.hasKey()
      }
    ])
  );

  res.json({
    defaultProvider: AI_PROVIDERS[DEFAULT_AI_PROVIDER] ? DEFAULT_AI_PROVIDER : 'groq',
    providers
  });
});

app.get('/api/ai/settings', async (req, res) => {
  try {
    const settings = await loadAiSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/settings', async (req, res) => {
  try {
    const { provider, model } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'Missing provider.' });
    const saved = await saveAiSettings({ provider, model });
    res.json({ ok: true, settings: saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/ai/analyze-bill', async (req, res) => {
  try {
    const bill = await analyzeBillText(req.body || {});
    res.json({ ok: true, bill });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ── WhatsApp bridge ─────────────────────────────────────────────────────────

app.post('/api/whatsapp/analyze-ocr', async (req, res) => {
  try {
    const {
      text,
      provider,
      model,
      imageBase64,
      imageMime,
      fileName
    } = req.body || {};

    let attachment = null;
    if (imageBase64) {
      try {
        const buffer = Buffer.from(imageBase64, 'base64');
        if (buffer.length > 0) {
          const filename = await saveUploadedBuffer(buffer, imageMime);
          attachment = {
            filename,
            mime: imageMime || 'application/octet-stream',
            originalName: fileName || filename
          };
        }
      } catch (err) {
        console.error('Failed to persist uploaded image:', err.message);
      }
    }

    const bill = await analyzeBillText({ text, provider, model });

    let connections = [];
    let xeroAvailable = false;
    try {
      const conn = await getValidConnections();
      connections = conn.connections;
      xeroAvailable = Boolean(conn.tokens?.accessToken);
    } catch (err) {
      console.error('Could not refresh Xero connections for analyze-ocr:', err.message);
    }

    const matchedTenant = matchTenantByName(bill.billedTo, connections);
    const candidatesList = connections.map((c) => ({
      tenantId: c.tenantId,
      tenantName: c.tenantName
    }));

    let xero = null;
    let pending = null;

    if (matchedTenant && xeroAvailable) {
      let sourceFile = null;
      if (attachment) {
        try {
          sourceFile = {
            buffer: await readUploadedFile(attachment.filename),
            mimetype: attachment.mime,
            originalname: attachment.originalName
          };
        } catch (err) {
          console.error('Could not read attachment for matched bill:', err.message);
        }
      }
      try {
        const result = await createDraftBill({
          bill,
          sourceFile,
          tenantId: matchedTenant.tenantId
        });
        xero = {
          ...result,
          tenantId: matchedTenant.tenantId,
          tenantName: matchedTenant.tenantName
        };
        await saveBillRecord(buildBillRecord({
          bill,
          result,
          tenant: matchedTenant,
          source: 'whatsapp'
        }));
        if (attachment) {
          await deleteUploadedFile(attachment.filename);
          attachment = null;
        }
      } catch (xeroError) {
        // Park as pending so the user can retry from the UI
        pending = await appendPendingBill({
          id: crypto.randomUUID(),
          bill,
          billedTo: bill.billedTo,
          attachedFile: attachment,
          reason: `Auto-create failed in ${matchedTenant.tenantName}: ${xeroError.message}`,
          suggestedTenantId: matchedTenant.tenantId,
          candidates: candidatesList,
          source: 'whatsapp',
          createdAt: isoNow()
        });
      }
    } else if (xeroAvailable) {
      // No match → queue for manual assignment
      pending = await appendPendingBill({
        id: crypto.randomUUID(),
        bill,
        billedTo: bill.billedTo,
        attachedFile: attachment,
        reason: 'No matching organisation found for "' + (bill.billedTo || '(empty BILL TO)') + '".',
        suggestedTenantId: null,
        candidates: candidatesList,
        source: 'whatsapp',
        createdAt: isoNow()
      });
    }

    res.json({
      ok: true,
      bill,
      matchedTenant: matchedTenant
        ? { tenantId: matchedTenant.tenantId, tenantName: matchedTenant.tenantName }
        : null,
      xero,
      pending: pending
        ? {
            id: pending.id,
            reason: pending.reason,
            candidates: pending.candidates
          }
        : null,
      candidates: candidatesList
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

// ── WhatsApp full-pipeline endpoints (tesseract → Groq → match) ─────────────

// Accepts the raw file (base64) from webhook.php OR a multipart upload.
// Runs tesseract → Groq → tenant match. If matched, creates the Xero draft.
// If unmatched, stores pending bill AND sets per-chat picker state.
app.post('/api/whatsapp/process-file', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    const chatId = (body.chatId || '').toString().trim();
    const fileName = body.fileName || body.filename || (req.file?.originalname) || '';

    let buffer = null;
    let mime = body.mime || body.imageMime || req.file?.mimetype || 'application/octet-stream';

    if (req.file?.buffer) {
      buffer = req.file.buffer;
    } else if (body.fileBase64 || body.imageBase64) {
      buffer = Buffer.from(body.fileBase64 || body.imageBase64, 'base64');
    }

    if (!buffer || !buffer.length) {
      return res.status(400).json({ error: 'No file provided (expect multipart "file" or JSON fileBase64).' });
    }

    // Persist attachment so it can be reused by picker resolution / Xero attach
    const filename = await saveUploadedBuffer(buffer, mime);
    const attachment = {
      filename,
      mime,
      originalName: fileName || filename
    };

    // OCR via tesseract.js (PDFs are rasterized to PNG first)
    let ocrText = '';
    try {
      ocrText = await runTesseractOcr(buffer, mime);
    } catch (ocrErr) {
      console.error('Tesseract OCR failed:', ocrErr.message);
      await deleteUploadedFile(filename);
      return res.status(500).json({ error: `OCR failed: ${ocrErr.message}` });
    }

    if (!ocrText.trim()) {
      await deleteUploadedFile(filename);
      return res.json({ ok: true, status: 'empty', ocrText: '' });
    }

    // Structure via Groq
    let bill;
    try {
      bill = await analyzeBillText({ text: ocrText, provider: 'groq' });
    } catch (analysisErr) {
      console.error('Groq bill analysis failed:', analysisErr.message);
      await deleteUploadedFile(filename);
      return res.status(500).json({ error: `AI analysis failed: ${analysisErr.message}`, ocrText });
    }

    const outcome = await processBillForChat({
      bill,
      attachment,
      chatId,
      source: 'whatsapp'
    });

    res.json({ ok: true, ocrText, ...outcome });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

// Accepts a free-text WhatsApp message. Routing priority:
//   1) Picker state for this chat — resolve to a tenant choice if reply matches
//   2) Built-in commands (orgs / pending / help)
//   3) General Groq chat
app.post('/api/whatsapp/chat', async (req, res) => {
  try {
    const { chatId, text } = req.body || {};
    const message = String(text || '').trim();
    if (!chatId || !message) {
      return res.status(400).json({ error: 'Missing chatId or text.' });
    }

    // 1) Picker resolution
    const state = await getChatState(chatId);
    if (state?.awaitingPicker?.pendingBillId) {
      const lower = message.toLowerCase();
      if (['cancel', 'batal', 'skip', 'stop'].includes(lower)) {
        await clearChatState(chatId, 'awaitingPicker');
        return res.json({ ok: true, kind: 'picker-cancelled', reply: '👍 Cancelled. The bill is still in *Pending* — open the dashboard to assign it later.' });
      }
      const result = await resolvePickerForChat(chatId, message);
      if (result?.resolved) {
        const lines = [
          '✅ *Xero draft bill created*',
          `Organisation: ${result.tenant.tenantName}`,
          `Supplier: ${result.xero.contactName || result.bill.supplier || '-'}`,
          `Invoice: ${result.xero.invoiceNumber || result.xero.invoiceId}`
        ];
        if (result.xero.total != null) {
          lines.push(`Total: ${result.bill.currency || ''} ${Number(result.xero.total).toFixed(2)}`.trim());
        }
        lines.push(`View: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${result.xero.invoiceId}`);
        return res.json({ ok: true, kind: 'picker-resolved', reply: lines.join('\n'), xero: result.xero });
      }
      // Could not resolve → fall through to chat but include a hint
      if (result && !result.resolved && result.reason !== 'No matching choice') {
        await clearChatState(chatId, 'awaitingPicker');
        return res.json({ ok: true, kind: 'picker-error', reply: `⚠️ ${result.reason}. The pick has been cancelled.` });
      }
      // Reply did not look like a choice — keep picker state and fall through to chat
    }

    // 2) Commands
    const lower = message.toLowerCase();
    if (['orgs', 'organisations', 'organizations', 'tenants'].includes(lower)) {
      const { connections } = await getValidConnections();
      if (!connections.length) {
        return res.json({ ok: true, kind: 'command', reply: '⚠️ No Xero organisations connected yet. Open the dashboard to connect.' });
      }
      const list = connections.map((c, i) => `${i + 1}. ${c.tenantName}`).join('\n');
      return res.json({ ok: true, kind: 'command', reply: `🏢 *Connected Xero organisations:*\n${list}` });
    }
    if (['pending', 'unmatched', 'queue'].includes(lower)) {
      const list = await loadPendingBills();
      if (!list.length) {
        return res.json({ ok: true, kind: 'command', reply: '✅ No pending bills. All clean.' });
      }
      const lines = list.slice(0, 8).map((p, i) =>
        `${i + 1}. ${p.bill?.supplier || 'Unknown'} → ${p.billedTo || '(no billed to)'} (${(p.bill?.currency || '')} ${Number(p.bill?.total || 0).toFixed(2)})`
      );
      return res.json({ ok: true, kind: 'command', reply: `📋 *Pending bills (${list.length}):*\n${lines.join('\n')}` });
    }
    if (['help', 'commands', '?'].includes(lower)) {
      return res.json({
        ok: true,
        kind: 'command',
        reply: '🤖 *WazzOCR commands*\n• Send an image/PDF — I extract & post to Xero\n• `orgs` — list connected Xero organisations\n• `pending` — list bills awaiting assignment\n• `help` — this message\n\nOr just chat naturally — ask me anything!'
      });
    }

    // 3) General Groq chat
    const reply = await callGroqChat(message);
    return res.json({ ok: true, kind: 'chat', reply });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Direct picker resolution endpoint (alternative to the chat-routing path).
// Useful if webhook.php parses a button reply explicitly.
app.post('/api/whatsapp/picker/resolve', async (req, res) => {
  try {
    const { chatId, choice } = req.body || {};
    if (!chatId || choice == null) {
      return res.status(400).json({ error: 'Missing chatId or choice.' });
    }
    const result = await resolvePickerForChat(chatId, choice);
    if (!result) return res.status(404).json({ error: 'No picker awaiting for this chat.' });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ── Xero connection routes ──────────────────────────────────────────────────

app.get('/api/xero/status', async (req, res) => {
  try {
    const { grants, connections } = await getValidConnections();
    const latestGrant = (grants || [])
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;

    if (!latestGrant?.accessToken || !connections.length) {
      return res.json({
        connected: false,
        connectUrl: '/api/xero/connect',
        redirectUri: getOAuthRedirectUri(req),
        defaultAccountCode: XERO_DEFAULT_ACCOUNT_CODE,
        defaultTaxType: XERO_DEFAULT_TAX_TYPE,
        defaultCurrency: XERO_DEFAULT_CURRENCY
      });
    }

    res.json({
      connected: true,
      tenants: connections.map((c) => ({
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        tenantType: c.tenantType,
        connectedBy: c.connectedBy,
        createdDateUtc: c.createdDateUtc,
        updatedDateUtc: c.updatedDateUtc
      })),
      grantCount: grants.length,
      expiresAt: latestGrant.expiresAt,
      scope: latestGrant.scope,
      connectUrl: '/api/xero/connect',
      redirectUri: getOAuthRedirectUri(req),
      defaultAccountCode: XERO_DEFAULT_ACCOUNT_CODE,
      defaultTaxType: XERO_DEFAULT_TAX_TYPE,
      defaultCurrency: XERO_DEFAULT_CURRENCY
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

app.get('/api/xero/tenants', async (req, res) => {
  try {
    const { connections } = await getValidConnections();
    res.json({
      tenants: connections.map((c) => ({
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        tenantType: c.tenantType,
        connectedBy: c.connectedBy
      }))
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/xero/connect', async (req, res) => {
  try {
    ensureConfig();
    const redirectUri = getOAuthRedirectUri(req);
    const state = crypto.randomBytes(24).toString('hex');
    await writeJson(STATE_FILE, { state, redirectUri, createdAt: isoNow() });
    const authUrl = new URL(`${XERO_IDENTITY_BASE}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', XERO_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', XERO_SCOPES);
    authUrl.searchParams.set('state', state);
    res.redirect(authUrl.toString());
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/api/xero/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) {
      throw new Error(errorDescription || error);
    }

    const savedState = await readJson(STATE_FILE, null);
    if (!state || !savedState?.state || state !== savedState.state) {
      throw new Error('Invalid Xero OAuth state. Please try connecting again.');
    }

    const redirectUri = savedState.redirectUri || getOAuthRedirectUri(req);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const connections = await fetchConnections(tokens.accessToken);

    const store = await loadTokenStore();
    const grant = normalizeTokenGrant(tokens, connections);
    const existingIndex = (store.grants || []).findIndex((item) => item.id === grant.id);
    if (existingIndex === -1) {
      store.grants = [...(store.grants || []), grant];
    } else {
      store.grants[existingIndex] = normalizeTokenGrant(tokens, connections, store.grants[existingIndex]);
    }
    await saveTokenStore(store);
    await writeJson(STATE_FILE, { state: null, clearedAt: isoNow() });

    res.redirect('/index.html?xero=connected#settings');
  } catch (error) {
    res.status(500).send(`<pre>Xero connection failed: ${error.message}</pre>`);
  }
});

app.get('/api/xero/tax-rates', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Missing tenantId.' });
    const payload = await xeroApi('/TaxRates', {}, tenantId);
    const rates = (payload.TaxRates || [])
      .filter((r) => r.Status !== 'DELETED')
      .map((r) => ({
        taxType: r.TaxType,
        name: r.Name,
        displayTaxRate: r.DisplayTaxRate,
        effectiveRate: r.EffectiveRate
      }));
    res.json({ taxRates: rates });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/xero/create-bill', upload.single('sourceImage'), async (req, res) => {
  try {
    const raw = req.body.bill;
    const tenantId = req.body.tenantId;
    if (!raw) return res.status(400).json({ error: 'Missing bill payload.' });
    if (!tenantId) return res.status(400).json({ error: 'Missing tenantId. Pick an organisation to create the draft in.' });

    const bill = JSON.parse(raw);
    const result = await createDraftBill({ bill, sourceFile: req.file, tenantId });

    const { connections } = await getValidConnections();
    const tenant = connections.find((c) => c.tenantId === tenantId) || { tenantId, tenantName: null };

    await saveBillRecord(buildBillRecord({
      bill,
      result,
      tenant,
      source: req.body.source || 'web'
    }));

    res.json({
      ok: true,
      message: `Draft bill ${result.invoiceNumber || result.invoiceId} created in ${tenant.tenantName || 'Xero'}.`,
      bill: result,
      tenant
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

// ── Bills history ───────────────────────────────────────────────────────────

app.get('/api/bills', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    const bucket = String(req.query.bucket || 'active').toLowerCase();
    const all = await loadBills();
    let bills = tenantId ? all.filter((b) => b.tenantId === tenantId) : all;
    if (bucket === 'archived') {
      bills = bills.filter(isArchivedBillRecord);
    } else if (bucket !== 'all') {
      bills = bills.filter((b) => !isArchivedBillRecord(b));
    }
    res.json({ bills });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bills/:id/open', async (req, res) => {
  try {
    const bills = await loadBills();
    const record = bills.find((bill) => bill.id === req.params.id);
    if (!record) return res.status(404).send('Bill history record not found.');
    if (!record.invoiceId || !record.tenantId) return res.status(400).send('Bill history record is missing Xero invoice information.');

    let targetUrl = record.xeroUrl || `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${encodeURIComponent(record.invoiceId)}`;
    try {
      const invoice = await fetchXeroBill(record.invoiceId, record.tenantId);
      if (invoice?.Url) targetUrl = invoice.Url;
    } catch (error) {
      console.error(`Could not refresh Xero open link for ${record.invoiceId}:`, error.message);
    }

    res.redirect(targetUrl);
  } catch (error) {
    res.status(error.statusCode || 500).send(error.message);
  }
});

app.delete('/api/bills/:id', async (req, res) => {
  try {
    const bills = await loadBills();
    const idx = bills.findIndex((bill) => bill.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Bill history record not found.' });

    const record = bills[idx];
    if (!isArchivedBillRecord(record)) {
      return res.status(409).json({ error: 'Only voided or archived bill history records can be removed.' });
    }

    const [removed] = bills.splice(idx, 1);
    await saveBills(bills);
    res.json({ ok: true, removed: { id: removed.id, invoiceNumber: removed.invoiceNumber || removed.invoiceNo || null } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Reassign a bill from the wrong Xero organisation to the correct one.
//
// Flow (create-then-delete order, so a failure leaves the old draft intact):
//   1. Validate source record and target tenant.
//   2. Fetch the source invoice from Xero — refuse unless Status is DRAFT.
//   3. Download attachments from the source invoice.
//   4. Re-create the bill as a DRAFT in the target tenant (with attachment).
//   5. Soft-delete the source draft (Status: DELETED).
//   6. Mark the local record archived with replacedBy pointer; save new record.
app.post('/api/bills/:id/reassign', async (req, res) => {
  try {
    const { tenantId: targetTenantId } = req.body || {};
    if (!targetTenantId) {
      return res.status(400).json({ error: 'Missing tenantId for the target organisation.' });
    }

    const bills = await loadBills();
    const idx = bills.findIndex((bill) => bill.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Bill history record not found.' });
    const record = bills[idx];

    if (!record.invoiceId || !record.tenantId) {
      return res.status(400).json({ error: 'This bill record has no Xero invoice link — cannot reassign.' });
    }
    if (record.tenantId === targetTenantId) {
      return res.status(400).json({ error: 'Source and target organisations are the same.' });
    }
    if (isArchivedBillRecord(record)) {
      return res.status(409).json({ error: 'This bill has already been archived/voided — nothing to reassign.' });
    }

    const { connections } = await getValidConnections();
    const sourceTenant = connections.find((c) => c.tenantId === record.tenantId);
    const targetTenant = connections.find((c) => c.tenantId === targetTenantId);
    if (!sourceTenant) return res.status(404).json({ error: 'Source Xero organisation is no longer connected.' });
    if (!targetTenant) return res.status(404).json({ error: 'Target Xero organisation is not in your connections.' });

    // 2. Fetch source invoice and gate on DRAFT.
    let sourceInvoice;
    try {
      sourceInvoice = await fetchXeroBill(record.invoiceId, record.tenantId);
    } catch (err) {
      return res.status(err.statusCode || 502).json({
        error: `Could not load source bill from Xero: ${err.message}`
      });
    }
    if (!sourceInvoice?.InvoiceID) {
      return res.status(404).json({ error: 'Source bill no longer exists in Xero.' });
    }
    const sourceStatus = String(sourceInvoice.Status || '').toUpperCase();
    if (sourceStatus !== 'DRAFT') {
      return res.status(409).json({
        error: `Cannot reassign: source bill is "${sourceStatus}" in Xero, not DRAFT. Reassignment is only allowed while the bill is still a draft. Please handle this in Xero manually.`
      });
    }

    // 3. Download first attachment if any (we re-upload one — multi-attachment
    //    is rare for receipts and keeps the flow simple).
    let sourceFile = null;
    try {
      const attachments = await listXeroInvoiceAttachments(record.invoiceId, record.tenantId);
      const first = attachments[0];
      if (first?.FileName) {
        const buffer = await downloadXeroInvoiceAttachment(record.invoiceId, first.FileName, record.tenantId);
        if (buffer?.length) {
          sourceFile = {
            buffer,
            mimetype: first.MimeType || 'application/octet-stream',
            originalname: first.FileName
          };
        }
      }
    } catch (err) {
      console.error(`Could not transfer attachment for invoice ${record.invoiceId}:`, err.message);
    }

    // 4. Create in target tenant.
    const billForCreate = reconstructBillFromXeroInvoice(sourceInvoice, record);
    let createResult;
    try {
      createResult = await createDraftBill({
        bill: billForCreate,
        sourceFile,
        tenantId: targetTenantId
      });
    } catch (err) {
      return res.status(err.statusCode || 502).json({
        error: `Could not create bill in ${targetTenant.tenantName}: ${err.message}`,
        details: err.payload || null
      });
    }

    // 5. Delete source draft. If this fails, surface a warning but don't roll
    //    back the new draft — the user can clean up the old one manually.
    let deleteWarning = null;
    try {
      await deleteDraftXeroBill(record.invoiceId, record.tenantId);
    } catch (err) {
      console.error(`Failed to delete source draft ${record.invoiceId}:`, err.message);
      deleteWarning = `New draft created in ${targetTenant.tenantName}, but could not delete the original in ${sourceTenant.tenantName}: ${err.message}. Please void or delete it in Xero manually.`;
    }

    // 6. Persist: archive old record, save new record, link them both ways.
    const newRecord = buildBillRecord({
      bill: billForCreate,
      result: createResult,
      tenant: targetTenant,
      source: `${record.source || 'manual'}+reassigned`
    });
    newRecord.replaces = { id: record.id, tenantId: record.tenantId, tenantName: record.tenantName, invoiceId: record.invoiceId };

    const archivedOld = {
      ...record,
      status: deleteWarning ? record.status : 'DELETED',
      archivedAt: isoNow(),
      archiveReason: `Reassigned to ${targetTenant.tenantName}${deleteWarning ? ' (delete in Xero failed — see warning)' : ''}`,
      replacedBy: { id: newRecord.id, tenantId: targetTenant.tenantId, tenantName: targetTenant.tenantName, invoiceId: newRecord.invoiceId }
    };

    const nextBills = bills.slice();
    nextBills[idx] = archivedOld;
    nextBills.push(newRecord);
    await saveBills(nextBills);

    res.json({
      ok: true,
      warning: deleteWarning,
      from: { id: record.id, tenantId: record.tenantId, tenantName: record.tenantName, invoiceId: record.invoiceId },
      to: { id: newRecord.id, tenantId: newRecord.tenantId, tenantName: newRecord.tenantName, invoiceId: newRecord.invoiceId, xeroUrl: newRecord.xeroUrl }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null
    });
  }
});

app.all(['/api/cron/check-bill-statuses', '/api/webhook/check-bill-statuses'], async (req, res) => {
  try {
    if (BILL_STATUS_CRON_SECRET) {
      const supplied = req.query.secret || req.get('x-cron-secret') || '';
      if (!safeEquals(supplied, BILL_STATUS_CRON_SECRET)) {
        return res.status(401).json({ ok: false, error: 'Invalid cron secret.' });
      }
    }

    const result = await refreshStoredBillStatuses({
      tenantId: req.query.tenantId || null
    });
    await logBillStatusCron({
      timestamp: isoNow(),
      tenantId: req.query.tenantId || null,
      ...result
    });
    res.json(result);
  } catch (error) {
    await logBillStatusCron({
      timestamp: isoNow(),
      tenantId: req.query.tenantId || null,
      ok: false,
      error: error.message
    });
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

// ── Pending bills queue ─────────────────────────────────────────────────────

app.get('/api/pending-bills', async (req, res) => {
  try {
    const list = await loadPendingBills();
    const sanitized = list.map((p) => ({
      id: p.id,
      bill: p.bill,
      billedTo: p.billedTo,
      reason: p.reason,
      hasAttachment: Boolean(p.attachedFile),
      attachmentName: p.attachedFile?.originalName || null,
      candidates: p.candidates || null,
      suggestedTenantId: p.suggestedTenantId || null,
      source: p.source,
      createdAt: p.createdAt
    }));
    res.json({ pending: sanitized });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pending-bills/:id/assign', async (req, res) => {
  try {
    const { tenantId, taxType, accountCode, supplier, supplierName } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'Missing tenantId.' });

    const pending = await getPendingBill(req.params.id);
    if (!pending) return res.status(404).json({ error: 'Pending bill not found.' });

    const { connections } = await getValidConnections();
    const tenant = connections.find((c) => c.tenantId === tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found in your Xero connections.' });

    let sourceFile = null;
    if (pending.attachedFile) {
      try {
        sourceFile = {
          buffer: await readUploadedFile(pending.attachedFile.filename),
          mimetype: pending.attachedFile.mime,
          originalname: pending.attachedFile.originalName
        };
      } catch (err) {
        console.error('Pending attachment missing on disk:', err.message);
      }
    }

    const billForCreate = { ...pending.bill };
    if (supplier || supplierName) billForCreate.supplier = supplier || supplierName;
    if (taxType) billForCreate.taxType = taxType;
    if (accountCode) billForCreate.accountCode = accountCode;
    const result = await createDraftBill({ bill: billForCreate, sourceFile, tenantId });

    await saveBillRecord(buildBillRecord({
      bill: billForCreate,
      result,
      tenant,
      source: pending.source ? `${pending.source}+manual-assign` : 'manual-assign'
    }));

    await removePendingBill(req.params.id);
    if (pending.attachedFile) await deleteUploadedFile(pending.attachedFile.filename);

    res.json({
      ok: true,
      bill: result,
      tenant: { tenantId: tenant.tenantId, tenantName: tenant.tenantName }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null
    });
  }
});

app.delete('/api/pending-bills/:id', async (req, res) => {
  try {
    const removed = await removePendingBill(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Pending bill not found.' });
    if (removed.attachedFile) await deleteUploadedFile(removed.attachedFile.filename);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FusionETA OCR + Xero app running at http://localhost:${PORT}`);
});
