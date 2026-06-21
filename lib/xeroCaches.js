// Per-tenant caches for Xero reference data that rarely changes within a run:
//   • taxRateCache        tenantId -> [{ taxType, name, displayTaxRate, effectiveRate }]
//   • expenseAccountsCache tenantId -> [{ code, name, type }]
//
// These live for the process lifetime, so a tax rate / account created in Xero
// AFTER it's cached won't be seen until cleared. The dashboards expose a
// "Refresh" action that calls clearTenant() for an account's orgs, so newly
// added Xero tax rates / accounts are picked up without a server restart.
const taxRateCache = new Map();
const expenseAccountsCache = new Map();

function clearTenant(tenantId) {
  if (!tenantId) return false;
  const a = taxRateCache.delete(tenantId);
  const b = expenseAccountsCache.delete(tenantId);
  return a || b;
}

function clearAll() {
  taxRateCache.clear();
  expenseAccountsCache.clear();
}

module.exports = { taxRateCache, expenseAccountsCache, clearTenant, clearAll };
