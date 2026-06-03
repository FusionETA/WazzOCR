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
  DEFAULT_AI_PROVIDER = 'gemini',
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

  // Already ISO (YYYY-MM-DD): use as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Day-first numeric formats common on Malaysian invoices:
  //   DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (also 2-digit year).
  // `new Date()` reads these as US month-first, so 20/04/2026 becomes an
  // Invalid Date (no month 20) and the date silently drops. Parse explicitly.
  const dmy = trimmed.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (dmy) {
    let day = parseInt(dmy[1], 10);
    let month = parseInt(dmy[2], 10);
    let year = parseInt(dmy[3], 10);
    if (year < 100) year += 2000;
    // Assume day-first. Only flip to month-first when the layout proves it
    // (second field > 12, so it can only be the day).
    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(dt.getTime())) return undefined;
    return dt.toISOString().slice(0, 10);
  }

  // Fallback for textual dates like "30 Apr 2026" / "April 30, 2026".
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
  const fallback = AI_PROVIDERS[DEFAULT_AI_PROVIDER] ? DEFAULT_AI_PROVIDER : 'gemini';
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

// Per-tenant cache for tax rates (TTL: process lifetime). Tax rates change
// rarely, no need to hit /TaxRates on every bill.
const _taxRateCache = new Map();

async function getTenantTaxRates(tenantId) {
  if (_taxRateCache.has(tenantId)) return _taxRateCache.get(tenantId);
  try {
    const payload = await xeroApi('/TaxRates', {}, tenantId);
    const rates = (payload.TaxRates || [])
      .filter((r) => r.Status !== 'DELETED' && r.CanApplyToExpenses !== false)
      .map((r) => ({
        taxType: r.TaxType,
        name: r.Name,
        displayTaxRate: parseFloat(r.DisplayTaxRate),
        effectiveRate: parseFloat(r.EffectiveRate)
      }))
      .filter((r) => Number.isFinite(r.effectiveRate));
    _taxRateCache.set(tenantId, rates);
    return rates;
  } catch (err) {
    console.error(`[tax] could not fetch tax rates for tenant ${tenantId}:`, err.message);
    return [];
  }
}

// Tax rates sometimes arrive as decimal fractions (e.g. 0.08 meaning 8%)
// instead of whole-number percents (8) — the OCR/AI is inconsistent. Anything
// in (0,1) is treated as a fraction and scaled to a percent. Real SST/GST/VAT
// rates are all >= 1%, so this is safe and fixes bills where 8% was emitted as
// "0.08", which previously fell below the 0.5% floor → no TaxType match → tax
// dumped into a separate line item instead of applied as a per-line rate.
function normalizeRatePercent(value) {
  const n = normalizeNumber(value, 0);
  if (n > 0 && n < 1) return n * 100;
  return n;
}

// Map a percentage (e.g. 6 for "6% SST") to an actual Xero TaxType code for
// the given tenant. Returns null if no rate is within 0.5% of the target.
async function findTaxTypeForPercent(tenantId, percent) {
  if (!Number.isFinite(percent) || percent < 0.5) return null; // < 0.5% → treat as no tax
  const rates = await getTenantTaxRates(tenantId);
  let best = null;
  for (const r of rates) {
    const diff = Math.abs(r.effectiveRate - percent);
    if (diff < 0.5 && (!best || diff < best.diff)) {
      best = { ...r, diff };
    }
  }
  return best ? best.taxType : null;
}

function deriveBillTaxPercent(bill) {
  const explicitRate = normalizeRatePercent(firstPresent(bill?.taxRate, bill?.taxPercent, bill?.serviceTaxRate, bill?.sstRate));
  if (explicitRate > 0) return explicitRate;

  const taxAmount = normalizeNumber(bill?.tax);
  if (taxAmount <= 0) return 0;

  const taxableAmount = normalizeNumber(firstPresent(bill?.taxableAmount, bill?.taxableBase, bill?.taxableSubtotal), 0);
  if (taxableAmount > 0) return (taxAmount / taxableAmount) * 100;

  const lineTaxRate = (Array.isArray(bill?.lineItems) ? bill.lineItems : [])
    .map((item) => normalizeRatePercent(firstPresent(item.taxRate, item.taxPercent, item.serviceTaxRate, item.sstRate)))
    .find((rate) => rate > 0);
  if (lineTaxRate) return lineTaxRate;

  const subtotal = normalizeNumber(bill?.subtotal);
  return subtotal > 0 ? (taxAmount / subtotal) * 100 : 0;
}

async function resolveBillTaxTypes(bill, tenantId, fallbackTaxType) {
  const resolved = { ...bill };
  if (!Array.isArray(resolved.lineItems)) return resolved;

  const taxTypeByRate = new Map();
  async function getTaxTypeForRate(rate) {
    const rounded = Number(rate.toFixed(4));
    if (!taxTypeByRate.has(rounded)) {
      taxTypeByRate.set(rounded, await findTaxTypeForPercent(tenantId, rounded));
    }
    return taxTypeByRate.get(rounded);
  }

  resolved.lineItems = [];
  for (const item of bill.lineItems) {
    const line = { ...item };
    const amount = normalizeNumber(firstPresent(line.amount, line.lineAmount, line.LineAmount, line.total, line.Total), 0);
    const taxAmount = normalizeNumber(firstPresent(line.taxAmount, line.TaxAmount, line.tax), 0);
    let taxRate = normalizeRatePercent(firstPresent(line.taxRate, line.taxPercent, line.serviceTaxRate, line.sstRate));
    if (!taxRate && amount > 0 && taxAmount > 0) {
      taxRate = (taxAmount / amount) * 100;
    }

    if (!line.taxType && taxRate > 0) {
      line.taxType = await getTaxTypeForRate(taxRate);
    }
    if (!line.taxType && taxAmount > 0 && fallbackTaxType && fallbackTaxType !== 'NONE') {
      line.taxType = fallbackTaxType;
    }

    resolved.lineItems.push(line);
  }

  return resolved;
}

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
    const fallbackAmount = taxType && normalizeNumber(bill.subtotal) > 0
      ? normalizeNumber(bill.subtotal)
      : normalizeNumber(bill.total);
    const lineItem = {
      Description: `Receipt total${bill.invoiceNo ? ` for ${bill.invoiceNo}` : ''}`,
      Quantity: 1,
      UnitAmount: fallbackAmount
    };
    if (accountCode) lineItem.AccountCode = accountCode;
    if (taxType) lineItem.TaxType = taxType;
    return [lineItem];
  }

  const normalized = provided.map((item, index) => {
    let quantity = normalizeNumber(firstPresent(item.qty, item.quantity, item.Quantity), 1) || 1;
    const amount = normalizeNumber(firstPresent(item.amount, item.lineAmount, item.LineAmount, item.total, item.Total), 0);
    let unitPrice = normalizeNumber(
      firstPresent(item.unitPrice, item.unitAmount, item.UnitAmount, item.price, item.rate),
      // Derive from amount for BOTH positive and negative (negative = discount/credit).
      amount !== 0 ? amount / quantity : 0
    );

    // Consistency repair: Xero requires Quantity × UnitAmount = LineAmount,
    // and we round UnitAmount to 2dp before sending. Two failure modes:
    //   (a) AI gave inconsistent figures (qty × unit ≠ amount in raw values).
    //   (b) Rounding unit to 2dp loses precision when qty > 1
    //       (e.g. qty=35, unit=1.0143, amount=35.50 → rounded unit 1.01 →
    //        Xero computes 35×1.01=35.35, losing RM 0.15).
    // In either case, normalise to qty=1 + UnitAmount=amount so Xero's
    // computation matches the invoice exactly. Works for negative amounts too.
    const tentativeRoundedUnit = Number(unitPrice.toFixed(2));
    const computedFromRoundedUnit = quantity * tentativeRoundedUnit;
    if (amount !== 0 && Math.abs(computedFromRoundedUnit - amount) > 0.005) {
      console.warn(`[lineItems] Item ${index + 1} qty=${quantity} × unit≈${tentativeRoundedUnit} = ${computedFromRoundedUnit.toFixed(2)} ≠ amount ${amount}. Normalising to qty=1, unit=${amount}.`);
      quantity = 1;
      unitPrice = amount;
    }

    const description = String(firstPresent(item.description, item.Description, item.name) || `Line item ${index + 1}`).trim();
    const resolvedAccount = item.accountCode || accountCode;
    const taxRateValue = firstPresent(item.taxRate, item.taxPercent, item.serviceTaxRate, item.sstRate);
    const taxAmountValue = firstPresent(item.taxAmount, item.TaxAmount, item.tax);
    const hasExplicitTaxRate = item.taxRateExplicit === true || (item.taxRateExplicit === undefined &&
      taxRateValue !== undefined && taxRateValue !== null && taxRateValue !== ''
    );
    const hasExplicitTaxAmount = item.taxAmountExplicit === true || (item.taxAmountExplicit === undefined &&
      taxAmountValue !== undefined && taxAmountValue !== null && taxAmountValue !== ''
    );
    const lineExplicitlyNoTax = (
      hasExplicitTaxRate && normalizeNumber(taxRateValue, 0) <= 0
    ) || (
      hasExplicitTaxAmount && normalizeNumber(taxAmountValue, 0) <= 0 && normalizeNumber(taxRateValue, 0) <= 0
    );
    const resolvedTax = item.taxType || (lineExplicitlyNoTax ? null : taxType);
    const lineItem = {
      Description: description || `Line item ${index + 1}`,
      Quantity: quantity,
      UnitAmount: Number(unitPrice.toFixed(2))
    };
    if (resolvedAccount) lineItem.AccountCode = resolvedAccount;
    if (resolvedTax) lineItem.TaxType = resolvedTax;
    // Intentionally NOT sending LineAmount — let Xero compute it from
    // Quantity × UnitAmount. Sending it ourselves only creates a way to
    // disagree with Xero's own computation (and there's no upside).
    return lineItem;
  }).filter((item) => {
    // Keep zero-priced lines (e.g. free-tier AWS services, informational entries)
    // and negative lines (discounts / Savings-Plan credits). Drop only garbage:
    // non-finite UnitAmount or items with no description at all.
    return Number.isFinite(item.UnitAmount) && item.Description && item.Description.trim().length > 0;
  });

  if (!normalized.length) {
    throw new Error('No usable line items were found for the bill.');
  }

  // Top-level math sanity: if the sum of line items doesn't match the bill's
  // subtotal/total (e.g. AWS invoice where tesseract+AI hallucinated some
  // amounts), fall back to a single summary line using the trusted total.
  // Better one correct line than many wrong ones.
  const billSubtotal = normalizeNumber(bill.subtotal);
  const billTotal = normalizeNumber(bill.total);
  const expected = billSubtotal > 0 ? billSubtotal : billTotal;
  if (expected > 0) {
    const lineSum = normalized.reduce((s, li) => s + (li.Quantity * li.UnitAmount), 0);
    const diff = Math.abs(lineSum - expected);
    const tolerance = Math.max(1, expected * 0.02); // 2% or RM 1
    if (diff > tolerance) {
      console.warn(`[lineItems] Sum ${lineSum.toFixed(2)} ≠ expected ${expected.toFixed(2)} (diff ${diff.toFixed(2)}). Falling back to single summary line.`);
      const useAmount = taxType && expected > 0 ? expected : (billTotal > 0 ? billTotal : expected);
      const fallback = {
        Description: `Bill total${bill.invoiceNo ? ` (${bill.invoiceNo})` : ''} — line items inconsistent`,
        Quantity: 1,
        UnitAmount: Number(useAmount.toFixed(2))
      };
      if (accountCode) fallback.AccountCode = accountCode;
      if (taxType) fallback.TaxType = taxType;
      return [fallback];
    }
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

  // Determine the right Xero TaxType for this bill based on its declared
  // tax %. Example: invoice has subtotal 772.50 + tax 46.35 = 6% → find the
  // tenant's tax rate that's closest to 6% and apply it to every line. Falls
  // back to XERO_DEFAULT_TAX_TYPE ("NONE") if the bill has no tax or no rate
  // matches. Per-line `taxType` from the AI still wins if it sets one.
  let resolvedTaxType = XERO_DEFAULT_TAX_TYPE;
  const percent = deriveBillTaxPercent(bill);
  if (percent > 0) {
    const matched = await findTaxTypeForPercent(tenantId, percent);
    if (matched) {
      console.log(`[tax] bill tax ${percent.toFixed(2)}% → TaxType ${matched}`);
      resolvedTaxType = matched;
    } else {
      console.warn(`[tax] bill tax ${percent.toFixed(2)}% — no matching Xero tax rate; using ${XERO_DEFAULT_TAX_TYPE}`);
    }
  }

  const billForLines = await resolveBillTaxTypes(bill, tenantId, resolvedTaxType);
  const lineItems = deriveLineItems(billForLines, {
    accountCode: XERO_DEFAULT_ACCOUNT_CODE,
    taxType: resolvedTaxType
  });
  const hasAppliedTaxType = lineItems.some((line) => {
    const code = String(line.TaxType || '').trim().toUpperCase();
    return code && code !== 'NONE' && code !== 'EXEMPT';
  });
  const billTaxAmount = normalizeNumber(bill.tax);
  if (billTaxAmount > 0 && !hasAppliedTaxType) {
    const taxLine = {
      Description: `${bill.taxLabel || 'Tax'}${bill.invoiceNo ? ` for ${bill.invoiceNo}` : ''}`,
      Quantity: 1,
      UnitAmount: Number(billTaxAmount.toFixed(2))
    };
    if (XERO_DEFAULT_ACCOUNT_CODE) taxLine.AccountCode = XERO_DEFAULT_ACCOUNT_CODE;
    lineItems.push(taxLine);
  }

  const invoicePayload = {
    Invoices: [
      {
        Type: 'ACCPAY',
        Status: 'DRAFT',
        Contact: { ContactID: contact.ContactID },
        DateString: normalizeDateString(bill.date),
        // Due date intentionally not set — leave it to Xero / org defaults.
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

function buildBillPrompt(ocrText, knownOrgs = [], { vision = false } = {}) {
  const hasOrgList = Array.isArray(knownOrgs) && knownOrgs.length > 0;

  const orgListBlock = hasOrgList
    ? `

─── CONNECTED XERO ORGANISATIONS ───
The billedTo MUST be one of the organisations below. Copy the name VERBATIM
from this list (same spelling, spacing, capitalisation, punctuation, "Sdn Bhd",
parentheses — everything). Do not paraphrase, do not strip "fka" suffixes,
do not lowercase.

${knownOrgs.map((name, i) => `${i + 1}. ${name}`).join('\n')}

Matching rules — read carefully:
0. ★ "c/o" (care of) rule — CRITICAL:
   The actual billed entity is ALWAYS the company BEFORE "c/o" / "C/O" / "C\\O".
   Drop everything from "c/o" onwards. The "c/o" target is just an address
   forwarder, NOT the bill recipient.
   Example: "AYU BORNEO (SP) SDN BHD C/O EMJ RENOVATION SDN BHD"
            → billedTo = "Ayu Borneo (SP) Sdn Bhd"   ← match this in the list
            → billedToVerbatim = "AYU BORNEO (SP) SDN BHD C/O EMJ RENOVATION SDN BHD"
   Example: "Nova Spa & Wellness Sdn Bhd c/o Universe Wellness HQ"
            → billedTo = "Ayu Borneo Nova SB fka Nova Spa & Wellness Sdn Bhd"
            → billedToVerbatim = "Nova Spa & Wellness Sdn Bhd c/o Universe Wellness HQ"
1. Parenthetical abbreviations identify the BRANCH. Match them strictly:
     "(SP)" = Sri Petaling     "(KL)" = Kuala Lumpur
     "(PJ)" = Petaling Jaya    "(JB)" = Johor Bahru
     "(KK)" = Kota Kinabalu    "(KCH)" = Kuching
     "(KJ)" = Kelana Jaya      "(SJ)" = Subang Jaya
     "(AP)" = Ampang           "(BLK)" = Bandar Bukit Tinggi/relevant branch
     "(BSP)" = Bandar Sri Permaisuri
   If the invoice says "Ayu Borneo Sri Petaling" → return "Ayu Borneo (SP) Sdn Bhd".
   If the invoice says "Ayu Borneo SP" → return "Ayu Borneo (SP) Sdn Bhd".
2. "fka" means "formerly known as", and "SB" is the short form of "Sdn Bhd".
   For any entry of the form  "<CURRENT NAME> [SB|Sdn Bhd] fka <OLD NAME>":
     • <CURRENT NAME> is the company's NEW / current legal name.
     • <OLD NAME>     is what it used to be called.
     • "SB" and "Sdn Bhd" are interchangeable — treat them as equal.
   So  "Borneo Oasis Wellness SB fka Ayu Borneo (VC3) Sdn Bhd"
   means the company is CURRENTLY called "Borneo Oasis Wellness Sdn Bhd"
   and was FORMERLY called "Ayu Borneo (VC3) Sdn Bhd".

   The invoice may use EITHER the current name OR the old name. Match accordingly:
   ★ Invoice uses the CURRENT name:
       Example: invoice says "Borneo Oasis Wellness Sdn Bhd"
                → return "Borneo Oasis Wellness SB fka Ayu Borneo (VC3) Sdn Bhd"
                  (because "Borneo Oasis Wellness Sdn Bhd" == the part before "fka",
                   with SB expanded to Sdn Bhd)
       Example: invoice says "Ayu Borneo Nova Sdn Bhd"
                → return "Ayu Borneo Nova SB fka Nova Spa & Wellness Sdn Bhd"
   ★ Invoice uses the OLD name:
       Example: invoice says "Ayu Borneo (VC3) Sdn Bhd"
                → return "Borneo Oasis Wellness SB fka Ayu Borneo (VC3) Sdn Bhd"
       Example: invoice says "Nova Spa & Wellness Sdn Bhd"
                → return "Ayu Borneo Nova SB fka Nova Spa & Wellness Sdn Bhd"

   ★ CRITICAL — prefix-collision warning:
   Two listed orgs may share a prefix in their CURRENT name but be DIFFERENT
   companies. Do NOT pick the longer one when the invoice matches the shorter
   current name. Examples in this org list:
     • "Borneo Oasis Wellness SB fka …(VC3)…"     ← current = Borneo Oasis Wellness Sdn Bhd
     • "Borneo Oasis Wellness & Spa SB fka …(VC4)…" ← current = Borneo Oasis Wellness & Spa Sdn Bhd
   If the invoice says exactly "Borneo Oasis Wellness Sdn Bhd" (no "& Spa"),
   it is the VC3 entity, NOT the VC4 "& Spa" entity. Only pick "& Spa" when
   the invoice itself contains "& Spa" or "and Spa".
   When in doubt between two prefix-colliding entries and the invoice text
   doesn't contain the disambiguator, return billedTo = null and explain
   in "notes" so a human can pick.
3. If the BILL TO field is blank/ambiguous, infer from the delivery address,
   site name, or branch hints elsewhere in the invoice (e.g. "site: Sri Petaling"
   → "(SP) Sdn Bhd"; "shipped to Nova Spa" → the Nova entry above).
4. Plain "Ayu Borneo Sdn Bhd" with NO branch indicator → entry #5 only.
5. If two entries could plausibly match, prefer the one whose location matches
   the invoice's delivery address or branch banner.
6. If genuinely none of the listed orgs fit, set billedTo to null AND put your
   reasoning in "notes" (e.g. "Bill says 'XYZ Trading' which is not a connected
   org — manual review needed").

Also return a "billedToVerbatim" field with the original BILL TO text exactly
as it appears on the invoice, so a human can sanity-check the mapping.`
    : '';

  return `You are an expert at reading bills, receipts and invoices${vision ? ' directly from a photographed or scanned image/PDF' : ' from OCR-extracted text'}.
${vision ? `
VISION READING RULES — CRITICAL:
- Read the document by looking at it. Use the visual layout — column alignment,
  row grouping and table borders — to decide which numbers belong together.
- Numbers may be split across lines or columns. A figure like "5,787.08" may show
  the ringgit part ("5,787") in one cell/row and the cents ("08") in a separate
  line or the adjacent cents column. Recombine them into one value (5787.08).
- Align each amount to its correct line item by following the row, not by reading
  text top-to-bottom. Do not pair a description with a number from a different row.
- Handwriting and faint print are common. If a digit is genuinely unreadable,
  prefer null over guessing, and explain in "notes".
` : ''}
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
	- ${hasOrgList
	      ? 'billedTo MUST be an exact entry from the CONNECTED XERO ORGANISATIONS list below — copy it verbatim. Use "billedToVerbatim" for what the invoice actually says.'
	      : 'Always extract the billedTo as the FULL company name as it appears in the document (keep "Sdn Bhd", "(SP)", etc.). Do NOT shorten, expand or rewrite it.'}
	- If multiple addresses/branches appear, pick the one in the BILL TO / TO /
	  SOLD TO / INVOICE TO block, not the supplier's address.
	- If the text contains multiple separate invoices/bills (for example different
	  invoice numbers, separate page headers, or "Page 1 of 1" repeated), return
	  one object per invoice in "bills". Do NOT merge their line items or totals.
	- Preserve tax per line item. If a document has tax codes such as SV-8, SST-8,
	  SR-8, GST, or "Service Tax @ 8% on 220.00", set taxRate/taxAmount only on
	  the taxable line items. Lines outside the taxable base should have taxRate 0
	  and taxAmount 0.

	${vision ? 'Read the attached image/PDF and extract and return ONLY a valid JSON object:' : 'Given the raw OCR text below, extract and return ONLY a valid JSON object:'}
	{
	  "bills": [
	    {
	      "supplier": "Vendor / supplier company name (the company sending the invoice) or null",
	      "billedTo": ${hasOrgList ? '"EXACT name copied from the CONNECTED XERO ORGANISATIONS list below, or null if no entry fits"' : '"Customer / recipient company name (look for BILL TO, TO, SOLD TO, INVOICE TO sections). Full name as written; if c/o present, only the entity BEFORE c/o."'},
	      ${hasOrgList ? '"billedToVerbatim": "Original BILL TO text from the invoice (for human verification) or null",' : ''}
	      "invoiceNo": "Invoice number or null",
	      "date": "Date string or null",
	      "dueDate": "Due date string or null",
	      "currency": "MYR/USD/SGD etc, default MYR",
	      "lineItems": [{ "description": "string", "qty": 1, "unitPrice": 0.00, "amount": 0.00, "taxCode": "SV-8/SST-8/etc or null", "taxRate": 0.00, "taxAmount": 0.00 }],
	      "subtotal": 0.00,
	      "tax": 0.00,
	      "taxRate": 0.00,
	      "taxableAmount": 0.00,
	      "taxLabel": "SST/GST/VAT/Tax",
	      "discount": 0.00,
	      "total": 0.00,
	      "notes": "string or null"
	    }
	  ]
	}
	Return ONLY valid JSON. All amounts as numbers. null for missing strings, 0 for missing numbers.${orgListBlock}${vision ? '' : `

OCR Text:
${ocrText}`}`;
}

function extractJsonText(raw) {
  const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');
  const start = [objectStart, arrayStart].filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? -1;
  const end = cleaned[start] === '[' ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('The model did not return valid JSON.');
  }
  // LLMs (especially on bigger multi-bill payloads) often emit a trailing comma
  // before a closing } or ], which V8's JSON.parse rejects with
  // "Expected double-quoted property name...". A comma immediately before a
  // closing brace/bracket is never valid JSON, so stripping it only repairs.
  return cleaned.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1');
}

function normalizeBillPayload(bill) {
  const lineItems = Array.isArray(bill?.lineItems)
    ? bill.lineItems.map((item) => {
        const qty = normalizeNumber(firstPresent(item.qty, item.quantity, item.Quantity), 1) || 1;
        const amount = normalizeNumber(firstPresent(item.amount, item.lineAmount, item.LineAmount, item.total, item.Total), 0);
        const taxRateRaw = firstPresent(item.taxRate, item.taxPercent, item.serviceTaxRate, item.sstRate);
        const taxAmountRaw = firstPresent(item.taxAmount, item.TaxAmount, item.tax);
        const unitPrice = normalizeNumber(
          firstPresent(item.unitPrice, item.unitAmount, item.UnitAmount, item.price, item.rate),
          amount > 0 ? amount / qty : 0
        );
        return {
          ...item,
          description: firstPresent(item.description, item.Description, item.name) || '',
          qty,
          unitPrice,
          amount,
          taxCode: firstPresent(item.taxCode, item.TaxCode, item.taxLabel) || null,
          taxType: firstPresent(item.taxType, item.TaxType) || null,
          taxRate: normalizeNumber(taxRateRaw, 0),
          taxAmount: normalizeNumber(taxAmountRaw, 0),
          taxRateExplicit: taxRateRaw !== undefined && taxRateRaw !== null && taxRateRaw !== '',
          taxAmountExplicit: taxAmountRaw !== undefined && taxAmountRaw !== null && taxAmountRaw !== ''
        };
      })
    : [];

  // Strip "c/o ..." suffix if the AI ignored the prompt rule.
  //   "AYU BORNEO (SP) SDN BHD C/O EMJ RENOVATION SDN BHD"
  //   → billedTo:         "AYU BORNEO (SP) SDN BHD"
  //   → billedToVerbatim: original (so the user can see what the invoice said)
  // Handles c/o, C/O, c / o, C\O, etc. Splits on whitespace + slash variants.
  let cleanedBilledTo = bill?.billedTo || null;
  let preservedVerbatim = bill?.billedToVerbatim || null;
  if (cleanedBilledTo) {
    const coRegex = /\s+c\s*[\/\\]\s*o\s+/i;
    if (coRegex.test(cleanedBilledTo)) {
      const original = cleanedBilledTo;
      // Split on c/o, then strip trailing punctuation/whitespace so the
      // result can exact-match a tenant name (no trailing commas etc).
      cleanedBilledTo = original
        .split(coRegex)[0]
        .replace(/[\s,;.\-]+$/, '')
        .trim();
      if (!preservedVerbatim) preservedVerbatim = original;
    }
  }

  const normalized = {
    supplier: bill?.supplier || null,
    billedTo: cleanedBilledTo,
    billedToVerbatim: preservedVerbatim,
    invoiceNo: bill?.invoiceNo || null,
    date: bill?.date || null,
    dueDate: bill?.dueDate || null,
    currency: bill?.currency || XERO_DEFAULT_CURRENCY,
    lineItems,
    subtotal: normalizeNumber(bill?.subtotal),
    tax: normalizeNumber(bill?.tax),
    taxRate: normalizeNumber(firstPresent(bill?.taxRate, bill?.taxPercent, bill?.serviceTaxRate, bill?.sstRate), 0),
    taxableAmount: normalizeNumber(firstPresent(bill?.taxableAmount, bill?.taxableBase, bill?.taxableSubtotal), 0),
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

function normalizeBillPayloads(payload) {
  const rawBills = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.bills)
      ? payload.bills
      : payload?.bill
        ? [payload.bill]
        : [payload];

  return rawBills
    .map((bill) => normalizeBillPayload(bill))
    .filter((bill) => (
      bill.supplier ||
      bill.billedTo ||
      bill.invoiceNo ||
      bill.total > 0 ||
      bill.lineItems.length > 0
    ));
}

async function callGroqBillPayload(ocrText, model, knownOrgs = []) {
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
      messages: [{ role: 'user', content: buildBillPrompt(ocrText, knownOrgs) }],
      temperature: 0.1,
      max_tokens: 4096
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Groq analysis failed (${response.status}).`);
  }

  return JSON.parse(extractJsonText(payload.choices?.[0]?.message?.content));
}

async function callGroqBills(ocrText, model, knownOrgs = []) {
  return normalizeBillPayloads(await callGroqBillPayload(ocrText, model, knownOrgs));
}

async function callGroqBill(ocrText, model, knownOrgs = []) {
  return callGroqBills(ocrText, model, knownOrgs).then((bills) => bills[0] || normalizeBillPayload({}));
}

// Shared Gemini generateContent call → parsed JSON. `parts` is the array of
// content parts: text and/or inlineData (base64 image/PDF) for the vision path.
async function callGeminiJson(parts, model) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in .env.');
  }

  const useModel = model || AI_PROVIDERS.gemini.defaultModel;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.1,
        // 8192 leaves headroom for big bills; thinking is disabled below so
        // this budget is for actual output only.
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        // 2.5-series models spend "thinking" tokens that count against
        // maxOutputTokens. For deterministic JSON extraction we don't need
        // them — turn them off so the budget is spent on the answer.
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini analysis failed (${response.status}).`);
  }

  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!text.trim()) {
    const reason = candidate?.finishReason || 'no text returned';
    const safety = candidate?.safetyRatings ? ` safetyRatings=${JSON.stringify(candidate.safetyRatings)}` : '';
    throw new Error(`Gemini returned empty response (finishReason=${reason}).${safety}`);
  }
  try {
    return JSON.parse(extractJsonText(text));
  } catch (err) {
    const extracted = (() => { try { return extractJsonText(text); } catch { return text; } })();
    const pos = Number((/position (\d+)/.exec(err.message || '') || [])[1]);
    const diag = [
      `[gemini-diag] finishReason=${candidate?.finishReason} rawLen=${text.length} extractedLen=${extracted.length}`,
      Number.isFinite(pos)
        ? `[gemini-diag] window@${pos}: ${JSON.stringify(extracted.slice(Math.max(0, pos - 50), pos + 20))}`
        : `[gemini-diag] tail: ${JSON.stringify(extracted.slice(-80))}`
    ].join('\n');
    console.error(diag);
    try { require('fs').appendFileSync(__dirname + '/gemini-diag.log', new Date().toISOString() + ' ' + diag + '\n'); } catch {}
    throw err;
  }
}

async function callGeminiBillPayload(ocrText, model, knownOrgs = []) {
  return callGeminiJson([{ text: buildBillPrompt(ocrText, knownOrgs) }], model);
}

// Vision path: send the raw image/PDF bytes straight to Gemini so it does the
// reading + extraction in one shot — no Tesseract. Gemini sees the actual
// layout (columns, table rows, wrapped cents, handwriting) that flattened OCR
// text throws away.
async function callGeminiBillsFromImage(buffer, mime, model, knownOrgs = []) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty file: nothing to analyze.');
  }
  const isPdf = String(mime || '').toLowerCase() === 'application/pdf'
    || buffer.slice(0, 4).toString() === '%PDF';
  const mimeType = isPdf ? 'application/pdf' : (mime || 'image/jpeg');
  const parts = [
    { text: buildBillPrompt('', knownOrgs, { vision: true }) },
    { inlineData: { mimeType, data: buffer.toString('base64') } }
  ];
  return normalizeBillPayloads(await callGeminiJson(parts, model));
}

async function callGeminiBills(ocrText, model, knownOrgs = []) {
  return normalizeBillPayloads(await callGeminiBillPayload(ocrText, model, knownOrgs));
}

async function callGeminiBill(ocrText, model, knownOrgs = []) {
  return callGeminiBills(ocrText, model, knownOrgs).then((bills) => bills[0] || normalizeBillPayload({}));
}

async function analyzeBillText({ text, provider, model, knownOrgs = [] }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('OCR text is required for AI analysis.');
  }
  const settings = await loadAiSettings();
  const useProvider = provider || settings.provider;
  const useModel = model || settings.model;

  const selectedProvider = AI_PROVIDERS[useProvider] ? useProvider : settings.provider;
  if (selectedProvider === 'gemini') {
    return callGeminiBill(trimmed, useModel, knownOrgs);
  }
  return callGroqBill(trimmed, useModel, knownOrgs);
}

async function analyzeBillsText({ text, provider, model, knownOrgs = [] }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('OCR text is required for AI analysis.');
  }
  const settings = await loadAiSettings();
  const useProvider = provider || settings.provider;
  const useModel = model || settings.model;

  const selectedProvider = AI_PROVIDERS[useProvider] ? useProvider : settings.provider;
  const bills = selectedProvider === 'gemini'
    ? await callGeminiBills(trimmed, useModel, knownOrgs)
    : await callGroqBills(trimmed, useModel, knownOrgs);

  return bills.length ? bills : [normalizeBillPayload({})];
}

// ── File → bills pipeline ──────────────────────────────────────────────────
//
// Digital PDFs: extract embedded text (free, exact) and structure via the
// configured AI provider. Scanned PDFs and photos/images: send the raw bytes
// straight to Gemini vision — it reads the actual layout, no OCR step.

function resetPdfJsGlobalWorker() {
  try {
    delete globalThis.pdfjsWorker;
  } catch (_) {
    globalThis.pdfjsWorker = undefined;
  }
}

let _pdfJsLibPromise = null;
async function getPdfJsLib() {
  resetPdfJsGlobalWorker();
  if (!_pdfJsLibPromise) {
    _pdfJsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfJsLibPromise;
}

function toStandaloneUint8Array(buffer) {
  return new Uint8Array(buffer);
}


// Extracts embedded text from digital PDFs (no OCR). Returns '' if the PDF
// has no extractable text (e.g. scanned image of paper). Free, instant, and
// 100% accurate for digitally-generated PDFs like AWS / Xero / QuickBooks /
// most accounting-software invoices.
async function extractPdfEmbeddedText(buffer) {
  let doc;
  try {
    const { getDocument } = await getPdfJsLib();
    doc = await getDocument({
      data: toStandaloneUint8Array(buffer),
      disableFontFace: true,
      useSystemFonts: false
    }).promise;

    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent({ disableNormalization: false });
        const chunks = [];
        let lastY = null;
        for (const item of content.items || []) {
          if (!item || typeof item.str !== 'string') continue;
          const y = Array.isArray(item.transform) ? item.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(lastY - y) > 4 && chunks.length) {
            chunks.push('\n');
          }
          chunks.push(item.str);
          if (item.hasEOL) chunks.push('\n');
          else chunks.push(' ');
          if (y !== null) lastY = y;
        }
        const pageText = chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
        if (pageText) {
          pages.push(doc.numPages > 1 ? `─── Page ${i} of ${doc.numPages} ───\n${pageText}` : pageText);
        }
      } finally {
        page.cleanup();
      }
    }
    return pages.join('\n\n').trim();
  } catch (err) {
    console.error('[pdf-text] embedded extraction failed:', err.message);
    return '';
  } finally {
    try { await doc?.destroy?.(); } catch (_) { /* ignore */ }
    resetPdfJsGlobalWorker();
  }
}

// Smart entry point. Digital PDFs → embedded text (free, exact) → AI structuring
// via the configured provider. Scanned PDFs and images → Gemini vision directly
// (no OCR). Returns { bills, method, ocrText } so the caller can surface which
// path was used. ocrText is '' for the vision path (Gemini reads the file).
async function analyzeFileToBills({ buffer, mime, knownOrgs = [] }) {
  if (!buffer || !buffer.length) {
    throw new Error('Empty file: nothing to analyze.');
  }
  const isPdf = String(mime || '').toLowerCase() === 'application/pdf'
    || buffer.slice(0, 4).toString() === '%PDF';

  if (isPdf) {
    const embedded = await extractPdfEmbeddedText(buffer);
    // Threshold: >~50 useful chars means a digital PDF — use its embedded text.
    // Scanned PDFs yield 0 or a few stray glyphs, well below this, and fall
    // through to Gemini vision.
    if (embedded && embedded.replace(/\s+/g, ' ').length >= 50) {
      console.log(`[extract] PDF embedded text used (${embedded.length} chars) — text→AI path.`);
      const bills = await analyzeBillsText({ text: embedded, knownOrgs });
      return { bills, method: 'pdf-text', ocrText: embedded };
    }
    console.log('[extract] PDF has no usable embedded text — sending PDF to Gemini vision.');
  } else {
    console.log('[extract] image upload — sending to Gemini vision.');
  }

  const bills = await callGeminiBillsFromImage(buffer, mime, null, knownOrgs);
  return { bills, method: 'gemini-vision', ocrText: '' };
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

// ── General chat for non-bill WhatsApp messages ────────────────────────────
// Dispatches to the currently-configured AI provider.

const WAZZOCR_CHAT_SYSTEM_PROMPT = `You are WazzOCR, FusionETA's friendly WhatsApp assistant for bookkeeping.

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

async function callGroqChat(userMessage, history = []) {
  if (!GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY in .env.');
  }
  const messages = [
    { role: 'system', content: WAZZOCR_CHAT_SYSTEM_PROMPT },
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

async function callGeminiChat(userMessage, history = []) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in .env.');
  }
  // Gemini uses "user" / "model" roles and folds the system prompt into
  // a top-level systemInstruction field.
  const contents = [
    ...history.slice(-6).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  const model = AI_PROVIDERS.gemini.defaultModel;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: WAZZOCR_CHAT_SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 600
      }
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini chat failed (${response.status}).`);
  }
  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text.trim();
}

async function callAiChat(userMessage, history = []) {
  const settings = await loadAiSettings();
  if (settings.provider === 'groq') {
    return callGroqChat(userMessage, history);
  }
  return callGeminiChat(userMessage, history);
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

  // Trust the AI when it returns a billedTo that EXACTLY matches a connected
  // org name — the AI was given the org list in its prompt, so an exact-name
  // hit is authoritative. Falls back to fuzzy matchTenantByName for legacy /
  // edge cases (AI dropped a paren, slightly different casing, etc.).
  let matchedTenant = null;
  if (bill.billedTo && connections.length) {
    const target = String(bill.billedTo).trim().toLowerCase();
    matchedTenant = connections.find(
      (c) => String(c.tenantName || '').trim().toLowerCase() === target
    ) || null;
    if (matchedTenant) {
      console.log(`[match] AI exact-name hit → ${matchedTenant.tenantName}`);
    }
  }
  if (!matchedTenant) {
    matchedTenant = matchTenantByName(bill.billedTo, connections);
    if (matchedTenant) {
      console.log(`[match] fuzzy fallback hit → ${matchedTenant.tenantName}`);
    }
  }
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
      // AI matched the org confidently — Xero rejected the bill DATA, not
      // the org choice. Don't ask the user to pick (picking a different org
      // won't help). Park as pending so they can fix it from the dashboard.
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
      // Note: NOT setting awaitingPicker — the org is correct, the data is the problem.
      return {
        status: 'xero-error',
        bill,
        matchedTenant: { tenantId: matchedTenant.tenantId, tenantName: matchedTenant.tenantName },
        xeroError: xeroError.message,
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

  let result;
  try {
    result = await createDraftBill({
      bill: pending.bill,
      sourceFile,
      tenantId
    });
  } catch (xeroErr) {
    // Common case: Xero validation error (e.g. line totals don't match).
    // Keep the picker state alive so the user can retry with a different
    // org / cancel — and tell them WHY it failed.
    console.error(`[picker] createDraftBill failed for tenant ${tenant.tenantName}:`, xeroErr.message);
    return {
      resolved: false,
      reason: `Xero rejected this in ${tenant.tenantName}: ${xeroErr.message}`,
      keepState: true,
      tenant: { tenantId: tenant.tenantId, tenantName: tenant.tenantName }
    };
  }

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
    defaultProvider: AI_PROVIDERS[DEFAULT_AI_PROVIDER] ? DEFAULT_AI_PROVIDER : 'gemini',
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
    // Fetch connected orgs so the AI can pick billedTo from a known list.
    // Silently skip if Xero isn't connected — falls back to original behaviour.
    let knownOrgs = [];
    try {
      const { connections } = await getValidConnections();
      knownOrgs = connections.map((c) => c.tenantName).filter(Boolean);
    } catch (err) {
      console.error('analyze-bill: could not fetch Xero orgs (ok, fallback):', err.message);
    }
    const bill = await analyzeBillText({ ...(req.body || {}), knownOrgs });
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

    // Fetch connected orgs FIRST so the AI can pick billedTo from the known list.
    let connections = [];
    let xeroAvailable = false;
    try {
      const conn = await getValidConnections();
      connections = conn.connections;
      xeroAvailable = Boolean(conn.tokens?.accessToken);
    } catch (err) {
      console.error('Could not refresh Xero connections for analyze-ocr:', err.message);
    }
    const knownOrgs = connections.map((c) => c.tenantName).filter(Boolean);

    const bill = await analyzeBillText({ text, provider, model, knownOrgs });

    // Exact-name short-circuit (the AI was given the org list — trust it)
    let matchedTenant = null;
    if (bill.billedTo && connections.length) {
      const target = String(bill.billedTo).trim().toLowerCase();
      matchedTenant = connections.find(
        (c) => String(c.tenantName || '').trim().toLowerCase() === target
      ) || null;
    }
    if (!matchedTenant) {
      matchedTenant = matchTenantByName(bill.billedTo, connections);
    }
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

// ── WhatsApp full-pipeline endpoints (extract → AI → match) ────────────────

// Accepts the raw file (base64) from webhook.php OR a multipart upload.
// Runs extract → AI → tenant match. If matched, creates the Xero draft.
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
    let attachment = {
      filename,
      mime,
      originalName: fileName || filename
    };

    // Fetch connected orgs so the AI can pick billedTo from the known list.
    // This is what makes "Nova Spa & Wellness" → "Ayu Borneo Nova SB fka Nova Spa..."
    // work, plus all the "(SP)", "(VC3)" etc. branch matching.
    let knownOrgs = [];
    try {
      const { connections } = await getValidConnections();
      knownOrgs = (connections || []).map((c) => c.tenantName).filter(Boolean);
    } catch (err) {
      console.error('process-file: could not fetch Xero orgs (ok, fallback):', err.message);
    }

    // Smart analysis:
    //   • Digital PDFs (AWS, Xero, QuickBooks, etc.) → embedded text → AI (exact)
    //   • Scanned PDFs and photos/images → Gemini vision directly (no OCR)
    let ocrText = '';
    let extractionMethod = 'unknown';
    let bills;
    try {
      const out = await analyzeFileToBills({ buffer, mime, knownOrgs });
      bills = out.bills;
      ocrText = out.ocrText;
      extractionMethod = out.method;
    } catch (analysisErr) {
      console.error('File analysis failed:', analysisErr.message);
      await deleteUploadedFile(filename);
      return res.status(500).json({ error: `Analysis failed: ${analysisErr.message}`, ocrText });
    }

    if (!bills || !bills.length) {
      await deleteUploadedFile(filename);
      return res.json({ ok: true, status: 'empty', ocrText, extractionMethod });
    }

    const outcomes = [];
    if (bills.length <= 1) {
      outcomes.push(await processBillForChat({
        bill: bills[0],
        attachment,
        chatId,
        source: 'whatsapp'
      }));
      attachment = null;
    } else {
      await deleteUploadedFile(filename);
      attachment = null;
      for (const bill of bills) {
        const clonedFilename = await saveUploadedBuffer(buffer, mime);
        const clonedAttachment = {
          filename: clonedFilename,
          mime,
          originalName: fileName || clonedFilename
        };
        try {
          outcomes.push(await processBillForChat({
            bill,
            attachment: clonedAttachment,
            chatId,
            source: 'whatsapp+multi-bill'
          }));
        } catch (err) {
          await deleteUploadedFile(clonedFilename);
          throw err;
        }
      }
    }

    const primary = outcomes[0] || { status: 'empty', bill: bills[0] || normalizeBillPayload({}) };
    res.json({
      ok: true,
      ocrText,
      extractionMethod,
      multiBillCount: bills.length,
      bills,
      outcomes,
      ...primary
    });
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
//   3) General AI chat
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
      // Picker resolver returned an error.
      if (result && !result.resolved) {
        // Xero-side error (e.g. line totals don't match) — keep state so the
        // user can try another org or cancel. Surface the actual reason.
        if (result.keepState) {
          return res.json({
            ok: true,
            kind: 'picker-error',
            reply:
              `⚠️ ${result.reason}\n\n` +
              `Reply with a *different number*, or type *cancel* to skip and assign it from the dashboard.`
          });
        }
        // Hard error (pending bill gone, tenant disconnected, etc.) — clear state.
        if (result.reason !== 'No matching choice') {
          await clearChatState(chatId, 'awaitingPicker');
          return res.json({ ok: true, kind: 'picker-error', reply: `⚠️ ${result.reason}. The pick has been cancelled.` });
        }
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

    // 3) General AI chat (provider per loadAiSettings — Gemini by default)
    const reply = await callAiChat(message);
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
