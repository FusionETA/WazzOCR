// Ask Bills Hub where a premises' bills belong.
//
// Bills Hub keeps a register the finance team maintains: one row per utility
// or rental account at one building, saying which Xero organisation pays it
// and which contact to file it under. WazzOCR reads the premises address off
// a photographed bill and asks that register, because the paper cannot say
// either of those things.
//
//   GET {BILLHUB_URL}/api/recharge/premises?address=…&address=…&supplier=…
//
// Every address-like block goes up, not one of them. A bill prints the
// supplier's own office address, a billing address and the service address,
// and they look alike; choosing wrongly files the bill against the wrong
// company. The register matches all of them and returns the one it knows.
//
// Not cached. Somebody adds a row and expects the next bill to use it.
const ENDPOINT_PATH = '/api/recharge/premises';
const TIMEOUT_MS = Number(process.env.BILLHUB_TIMEOUT_MS || 8000);

function baseUrl() {
  const url = String(process.env.BILLHUB_URL || '').trim().replace(/\/+$/, '');
  return url || null;
}

const isConfigured = () => Boolean(baseUrl());

// Said once per process. A register that was never configured files every
// bill by name matching and, before this, left no trace of why — which is
// indistinguishable from a register that simply had no matching row.
let warned = false;
function warnNotConfigured() {
  if (warned) return;
  warned = true;
  console.warn('[register] BILLHUB_URL is not set, so the premises register is never asked.'
    + ' Every bill is filed by name matching alone. Set BILLHUB_URL and BILLHUB_TOKEN to use it.');
}

// Three outcomes, kept apart because they call for different things:
//
//   { found: true, … }                  the register knows this premises
//   { found: false }                    it does not — a real answer
//   { found: false, unavailable: true } we could not ask
//
// The third is NOT the second. "Nobody mapped it" and "Bills Hub is down"
// look the same to a caller that only checks for an answer, and treating a
// timeout as "not mapped" is how a bill ends up filed by guesswork during an
// outage.
async function lookup({ addresses = [], supplier = null } = {}) {
  const base = baseUrl();
  if (!base) return { found: false, unavailable: true, reason: 'BILLHUB_URL is not set' };

  const list = (Array.isArray(addresses) ? addresses : [addresses])
    .map((a) => String(a || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!list.length) return { found: false, reason: 'no address on the bill' };

  const params = new URLSearchParams();
  for (const a of list) params.append('address', a);
  if (supplier) params.set('supplier', String(supplier));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${ENDPOINT_PATH}?${params}`, {
      headers: {
        Accept: 'application/json',
        // Set BILLHUB_TOKEN on both sides. Without it Bills Hub answers 401
        // and this reports unavailable rather than "not mapped".
        ...(process.env.BILLHUB_TOKEN ? { 'X-Billhub-Token': process.env.BILLHUB_TOKEN } : {})
      },
      signal: controller.signal
    });

    if (res.status === 404) return { found: false };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { found: false, unavailable: true, reason: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }

    const data = await res.json();
    if (!data?.paidBy?.tenantId || !data?.contactName) {
      return { found: false, unavailable: true, reason: 'the register answered without a tenant or a contact' };
    }
    return {
      found: true,
      tenantId: data.paidBy.tenantId,
      tenantCode: data.paidBy.code || null,
      contactName: data.contactName,
      premisesAddress: data.premisesAddress || null
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS}ms` : err.message;
    return { found: false, unavailable: true, reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookup, isConfigured, warnNotConfigured, ENDPOINT_PATH };
