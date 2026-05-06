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
const XERO_IDENTITY_BASE = 'https://login.xero.com/identity/connect';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

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
  WHATSAPP_AUTO_CREATE_XERO_BILLS = 'false'
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
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

// ── Tenant matching: case-insensitive Levenshtein distance ≤ 1 ──────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  if (Math.abs(al - bl) > 1) return Math.abs(al - bl);

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

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTenantByName(billedTo, tenants) {
  if (!billedTo || !Array.isArray(tenants) || !tenants.length) return null;
  const normBill = normalizeName(billedTo);
  if (!normBill) return null;

  const scored = tenants.map((t) => ({
    tenant: t,
    distance: levenshtein(normBill, normalizeName(t.tenantName))
  }));

  const within = scored.filter((s) => s.distance <= 1);
  if (within.length === 0) return null;

  within.sort((a, b) => a.distance - b.distance);
  if (within.length === 1) return within[0].tenant;
  if (within[0].distance < within[1].distance) return within[0].tenant;
  return null; // ambiguous
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

  await writeJson(TOKEN_FILE, next);
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

async function getTokens({ refreshIfNeeded = true } = {}) {
  ensureConfig();
  const saved = await readJson(TOKEN_FILE, null);
  if (!saved?.refreshToken && !saved?.accessToken) {
    return null;
  }
  if (!refreshIfNeeded || !isTokenExpiringSoon(saved)) {
    return saved;
  }
  return refreshTokens(saved);
}

async function getValidConnections() {
  const tokens = await getTokens();
  if (!tokens?.accessToken) {
    return { tokens: null, connections: [] };
  }
  const connections = await fetchConnections(tokens.accessToken);
  if (JSON.stringify(tokens.connections || []) !== JSON.stringify(connections)) {
    tokens.connections = connections;
    tokens.updatedAt = isoNow();
    await writeJson(TOKEN_FILE, tokens);
  }
  return { tokens, connections };
}

async function xeroApi(pathname, { method = 'GET', body, headers = {}, raw = false } = {}, tenantId) {
  if (!tenantId) {
    throw new Error('tenantId is required for Xero API calls.');
  }
  const tokens = await getTokens();
  if (!tokens?.accessToken) {
    const error = new Error('Xero is not connected yet.');
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
  const supplierName = String(bill.supplier || '').trim();
  if (!supplierName) {
    throw new Error('Supplier name is required before creating a Xero bill.');
  }

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
    `InvoiceNumber=="${escapeXeroString(invoiceNumber)}"`
  ]);
  const payload = await xeroApi(`/Invoices?where=${encodeURIComponent(where)}`, {}, tenantId);
  return getFirstItem(payload, 'Invoices');
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
    const quantity = normalizeNumber(item.qty ?? item.quantity, 1) || 1;
    const amount = normalizeNumber(item.amount, 0);
    const unitPrice = normalizeNumber(item.unitPrice ?? item.unitAmount, amount > 0 ? amount / quantity : 0);
    const resolvedAccount = item.accountCode || accountCode;
    const resolvedTax = item.taxType || taxType;
    const lineItem = {
      Description: String(item.description || `Line item ${index + 1}`),
      Quantity: quantity,
      UnitAmount: Number(unitPrice.toFixed(2))
    };
    if (resolvedAccount) lineItem.AccountCode = resolvedAccount;
    if (resolvedTax) lineItem.TaxType = resolvedTax;
    return lineItem;
  });

  if (!normalized.length) {
    throw new Error('No usable line items were found for the bill.');
  }

  return normalized;
}

async function createDraftBill({ bill, sourceFile, tenantId }) {
  if (!tenantId) {
    throw new Error('tenantId is required.');
  }
  const contact = await findOrCreateContact(bill, tenantId);
  const duplicate = await findDuplicateBill(bill.invoiceNo, tenantId);
  if (duplicate?.InvoiceID) {
    const error = new Error(`A draft or existing bill with invoice number "${bill.invoiceNo}" already exists in Xero.`);
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

  const invoice = getFirstItem(createdPayload, 'Invoices');
  if (!invoice?.InvoiceID) {
    throw new Error('Xero did not return an invoice after creation.');
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
    invoiceNumber: invoice.InvoiceNumber,
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
    invoiceNo: bill.invoiceNo || null,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber || null,
    status: result.status,
    total: result.total,
    currency: result.currency,
    xeroUrl: result.url || `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${result.invoiceId}`,
    attachmentName: result.attachment?.fileName || null,
    source: source || 'manual',
    createdAt: isoNow()
  };
}

// ── AI bill analysis ────────────────────────────────────────────────────────

function buildBillPrompt(ocrText) {
  return `You are an expert at reading bills, receipts and invoices from OCR-extracted text.

Given the raw OCR text below, extract and return ONLY a valid JSON object:
{
  "supplier": "Vendor / supplier company name (the company sending the invoice) or null",
  "billedTo": "Customer / recipient company name (the company being billed - look for BILL TO, TO, SOLD TO, INVOICE TO sections) or null",
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
  const normalized = {
    supplier: bill?.supplier || null,
    billedTo: bill?.billedTo || null,
    invoiceNo: bill?.invoiceNo || null,
    date: bill?.date || null,
    dueDate: bill?.dueDate || null,
    currency: bill?.currency || XERO_DEFAULT_CURRENCY,
    lineItems: Array.isArray(bill?.lineItems) ? bill.lineItems : [],
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

// ── Xero connection routes ──────────────────────────────────────────────────

app.get('/api/xero/status', async (req, res) => {
  try {
    const tokens = await getTokens();
    if (!tokens?.accessToken) {
      return res.json({
        connected: false,
        connectUrl: '/api/xero/connect',
        redirectUri: getOAuthRedirectUri(req),
        defaultAccountCode: XERO_DEFAULT_ACCOUNT_CODE,
        defaultTaxType: XERO_DEFAULT_TAX_TYPE,
        defaultCurrency: XERO_DEFAULT_CURRENCY
      });
    }

    const { connections } = await getValidConnections();

    res.json({
      connected: true,
      tenants: connections.map((c) => ({
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        tenantType: c.tenantType,
        createdDateUtc: c.createdDateUtc,
        updatedDateUtc: c.updatedDateUtc
      })),
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
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
        tenantType: c.tenantType
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

    const persisted = {
      ...tokens,
      connections,
      updatedAt: isoNow()
    };
    await writeJson(TOKEN_FILE, persisted);
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
    const all = await loadBills();
    const bills = tenantId ? all.filter((b) => b.tenantId === tenantId) : all;
    res.json({ bills });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    const { tenantId, taxType, accountCode } = req.body || {};
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
