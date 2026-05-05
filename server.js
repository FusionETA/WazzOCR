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
const TOKEN_FILE = path.join(DATA_DIR, 'xero-tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'xero-auth-state.json');
const XERO_IDENTITY_BASE = 'https://login.xero.com/identity/connect';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

const {
  XERO_CLIENT_ID,
  XERO_CLIENT_SECRET,
  XERO_REDIRECT_URI = `http://localhost:${PORT}/api/xero/callback`,
  PUBLIC_APP_URL = '',
  XERO_SCOPES = 'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings',
  XERO_TENANT_ID = '',
  XERO_DEFAULT_ACCOUNT_CODE = '',
  XERO_DEFAULT_TAX_TYPE = 'NONE',
  XERO_DEFAULT_CURRENCY = 'MYR',
  SERVER_URL = `http://localhost:${PORT}`,
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
    return 'Xero authorization failed. Please reconnect Xero and make sure the selected tenant is still authorised for this app.';
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

function chooseTenant(connections) {
  if (!Array.isArray(connections) || !connections.length) {
    throw new Error('No Xero organisations are connected to this app.');
  }
  return connections[0];
}

function pickPreferredTenant(saved, connections) {
  if (!Array.isArray(connections) || !connections.length) {
    throw new Error('No Xero organisations are connected to this app.');
  }

  const preferredTenantId =
    saved?.selectedTenantId ||
    saved?.tenantId ||
    XERO_TENANT_ID ||
    null;

  if (preferredTenantId) {
    const matched = connections.find((item) => item.tenantId === preferredTenantId);
    if (matched) return matched;
  }

  return chooseTenant(connections);
}

function formatTenantSummary(connection, selectedTenantId) {
  return {
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    tenantType: connection.tenantType,
    createdDateUtc: connection.createdDateUtc,
    updatedDateUtc: connection.updatedDateUtc,
    isSelected: connection.tenantId === selectedTenantId
  };
}

async function loadTokens({ refreshIfNeeded = true } = {}) {
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

async function xeroApi(pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const saved = await loadTokens();
  if (!saved?.accessToken) {
    const error = new Error('Xero is not connected yet.');
    error.statusCode = 401;
    throw error;
  }

  const connections = await fetchConnections(saved.accessToken);
  const tenant = pickPreferredTenant(saved, connections);
  const tenantId = tenant.tenantId;

  if (
    saved.tenantId !== tenantId ||
    saved.selectedTenantId !== tenantId ||
    saved.tenantName !== tenant.tenantName
  ) {
    saved.tenantId = tenantId;
    saved.selectedTenantId = tenantId;
    saved.tenantName = tenant.tenantName || saved.tenantName;
    saved.connections = connections;
    await writeJson(TOKEN_FILE, saved);
  }

  const response = await fetch(`${XERO_API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${saved.accessToken}`,
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

async function resolveConnectionSummary() {
  const saved = await loadTokens();
  if (!saved?.accessToken) {
    return {
      connected: false,
      connectUrl: '/api/xero/connect',
      redirectUri: null,
      defaultAccountCode: XERO_DEFAULT_ACCOUNT_CODE,
      defaultTaxType: XERO_DEFAULT_TAX_TYPE,
      defaultCurrency: XERO_DEFAULT_CURRENCY
    };
  }

  const connections = await fetchConnections(saved.accessToken);
  const tenant = pickPreferredTenant(saved, connections);
  saved.tenantId = tenant.tenantId;
  saved.selectedTenantId = tenant.tenantId;
  saved.tenantName = tenant.tenantName;
  saved.connections = connections;
  await writeJson(TOKEN_FILE, saved);

  let organisationName = tenant.tenantName || null;
  try {
    const orgPayload = await xeroApi('/Organisation');
    organisationName = getFirstItem(orgPayload, 'Organisations')?.Name || organisationName;
  } catch (error) {
    // Keep tenant name if org lookup fails.
  }

  return {
    connected: true,
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    organisationName,
    tenants: connections.map((item) => formatTenantSummary(item, tenant.tenantId)),
    expiresAt: saved.expiresAt,
    scope: saved.scope,
    connectUrl: '/api/xero/connect',
    redirectUri: null,
    defaultAccountCode: XERO_DEFAULT_ACCOUNT_CODE,
    defaultTaxType: XERO_DEFAULT_TAX_TYPE,
    defaultCurrency: XERO_DEFAULT_CURRENCY
  };
}

async function findOrCreateContact(bill) {
  const supplierName = String(bill.supplier || '').trim();
  if (!supplierName) {
    throw new Error('Supplier name is required before creating a Xero bill.');
  }

  const exactWhere = buildWhereClause([
    `Name=="${escapeXeroString(supplierName)}"`,
    'ContactStatus=="ACTIVE"'
  ]);
  const contactsPayload = await xeroApi(`/Contacts?where=${encodeURIComponent(exactWhere)}`);
  const existing = getFirstItem(contactsPayload, 'Contacts');
  if (existing?.ContactID) {
    return existing;
  }

  const createdPayload = await xeroApi('/Contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Contacts: [
        {
          Name: supplierName
        }
      ]
    })
  });

  const created = getFirstItem(createdPayload, 'Contacts');
  if (!created?.ContactID) {
    throw new Error('Xero did not return a contact after creation.');
  }
  return created;
}

async function findDuplicateBill(invoiceNumber) {
  if (!invoiceNumber) return null;
  const where = buildWhereClause([
    'Type=="ACCPAY"',
    `InvoiceNumber=="${escapeXeroString(invoiceNumber)}"`
  ]);
  const payload = await xeroApi(`/Invoices?where=${encodeURIComponent(where)}`);
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

async function createDraftBill({ bill, sourceFile }) {
  const contact = await findOrCreateContact(bill);
  const duplicate = await findDuplicateBill(bill.invoiceNo);
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
  });

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
    });
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
    url: invoice.Url || null,
    attachment
  };
}

// ── AI bill analysis helpers ────────────────────────────────────────────────

function buildBillPrompt(ocrText) {
  return `You are an expert at reading bills, receipts and invoices from OCR-extracted text.

Given the raw OCR text below, extract and return ONLY a valid JSON object:
{
  "supplier": "Company name or null",
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

async function analyzeBillText({ text, provider = DEFAULT_AI_PROVIDER, model }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('OCR text is required for AI analysis.');
  }

  const selectedProvider = AI_PROVIDERS[provider] ? provider : DEFAULT_AI_PROVIDER;
  if (selectedProvider === 'gemini') {
    return callGeminiBill(trimmed, model);
  }
  return callGroqBill(trimmed, model);
}

// ────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));

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
  res.redirect('/index.html#xero-setup');
});

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

app.post('/api/ai/analyze-bill', async (req, res) => {
  try {
    const bill = await analyzeBillText(req.body || {});
    res.json({ ok: true, bill });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/analyze-ocr', async (req, res) => {
  try {
    const { text, provider, model, createBill } = req.body || {};
    const bill = await analyzeBillText({ text, provider, model });
    const shouldCreateBill = createBill ?? WHATSAPP_AUTO_CREATE_XERO_BILLS === 'true';
    let xero = null;

    if (shouldCreateBill) {
      xero = await createDraftBill({ bill, sourceFile: null });
    }

    res.json({ ok: true, bill, xero });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

app.get('/api/xero/status', async (req, res) => {
  try {
    const status = await resolveConnectionSummary();
    status.redirectUri = getOAuthRedirectUri(req);
    res.json(status);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
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
    const tenant = pickPreferredTenant(null, connections);

    const persisted = {
      ...tokens,
      tenantId: tenant.tenantId,
      selectedTenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      connections,
      updatedAt: isoNow()
    };
    await writeJson(TOKEN_FILE, persisted);
    await writeJson(STATE_FILE, { state: null, clearedAt: isoNow() });

    res.redirect('/index.html?xero=connected#xero-setup');
  } catch (error) {
    res.status(500).send(`<pre>Xero connection failed: ${error.message}</pre>`);
  }
});

app.post('/api/xero/select-tenant', async (req, res) => {
  try {
    const { tenantId } = req.body || {};
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing tenantId.' });
    }

    const saved = await loadTokens();
    if (!saved?.accessToken) {
      return res.status(401).json({ error: 'Xero is not connected yet.' });
    }

    const connections = await fetchConnections(saved.accessToken);
    const tenant = connections.find((item) => item.tenantId === tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Selected tenant was not found in your connected Xero organisations.' });
    }

    const next = {
      ...saved,
      tenantId: tenant.tenantId,
      selectedTenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      connections,
      updatedAt: isoNow()
    };
    await writeJson(TOKEN_FILE, next);

    res.json({
      ok: true,
      tenant: formatTenantSummary(tenant, tenant.tenantId)
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/xero/tax-rates', async (req, res) => {
  try {
    const payload = await xeroApi('/TaxRates');
    const rates = (payload.TaxRates || [])
      .filter(r => r.Status !== 'DELETED')
      .map(r => ({
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
    if (!raw) {
      return res.status(400).json({ error: 'Missing bill payload.' });
    }

    const bill = JSON.parse(raw);
    const result = await createDraftBill({ bill, sourceFile: req.file });
    res.json({
      ok: true,
      message: `Draft bill ${result.invoiceNumber || result.invoiceId} created in Xero.`,
      bill: result
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      details: error.payload || null,
      needsReconnect: Boolean(error.statusCode === 401 || String(error.message || '').toLowerCase().includes('reconnect xero'))
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FusionETA OCR + Xero app running at http://localhost:${PORT}`);
});
