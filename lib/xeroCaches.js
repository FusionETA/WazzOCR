// Per-tenant caches for Xero reference data that rarely changes within a run:
//   • taxRateCache        tenantId -> [{ taxType, name, displayTaxRate, effectiveRate }]
//   • expenseAccountsCache tenantId -> [{ code, name, type }]
//   • currencyCache       tenantId -> Set<string>  (enabled currency codes)
//
// These live for the process lifetime, so a tax rate / account created in Xero
// AFTER it's cached won't be seen until cleared. The dashboards expose a
// "Refresh" action that calls clearTenant() for an account's orgs, so newly
// added Xero tax rates / accounts are picked up without a server restart.
const taxRateCache = new Map();
const expenseAccountsCache = new Map();
const currencyCache = new Map();
const itemsCache = new Map();

function clearTenant(tenantId) {
  if (!tenantId) return false;
  const a = taxRateCache.delete(tenantId);
  const b = expenseAccountsCache.delete(tenantId);
  const c = currencyCache.delete(tenantId);
  const d = itemsCache.delete(tenantId);
  return a || b || c || d;
}

function clearAll() {
  taxRateCache.clear();
  expenseAccountsCache.clear();
  currencyCache.clear();
  itemsCache.clear();
}

module.exports = { taxRateCache, expenseAccountsCache, currencyCache, itemsCache, clearTenant, clearAll };
