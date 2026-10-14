// Is WazzOCR actually asking Bills Hub where a premises' bills belong?
//
//   node scripts/register-check.js "NO.23-1,SHOP OFFICE, JALAN EKO BOTANI 2F, 79100 ISKANDAR PUTERI"
//   node scripts/register-check.js "<address>" --supplier "TENAGA NASIONAL BERHAD"
//
// Read-only, and makes no Xero call. It exists because every way this can
// fail ends the same way — the bill is filed by name matching — so the
// symptom never says which of them happened.
// Tolerant, so the check still runs on a box where dependencies are not
// installed and the values come from the environment instead.
try { require('dotenv').config({ path: __dirname + '/../.env' }); } catch { /* env only */ }
const register = require('../lib/premisesRegister');

const argv = process.argv.slice(2);
const supIdx = argv.findIndex((a) => a === '--supplier');
const supplier = supIdx > -1 ? argv[supIdx + 1] : null;
const addresses = argv.filter((a, i) => !a.startsWith('--') && i !== supIdx + 1);

(async () => {
  const url = String(process.env.BILLHUB_URL || '').trim();
  const token = String(process.env.BILLHUB_TOKEN || '').trim();

  console.log('\nConfiguration (from .env)');
  console.log(`  BILLHUB_URL    ${url || 'NOT SET  ← the register is never asked'}`);
  console.log(`  BILLHUB_TOKEN  ${token ? `set, ${token.length} characters` : 'NOT SET  ← Bills Hub will answer 401'}`);

  if (!url) {
    console.log('\nWithout BILLHUB_URL every bill is filed by name matching alone.');
    console.log('Add both to .env and restart WazzOCR:\n');
    console.log('  BILLHUB_URL=https://billhub.fusioneta.com.my');
    console.log('  BILLHUB_TOKEN=<the same value as BILLHUB_SERVICE_TOKEN in Bills Hub\'s .env>\n');
    process.exitCode = 1;
    return;
  }

  if (!addresses.length) {
    console.log('\nGive it an address to look up, exactly as the bill prints it:\n');
    console.log('  node scripts/register-check.js "NO.23-1,SHOP OFFICE, JALAN EKO BOTANI 2F, 79100 ISKANDAR PUTERI"\n');
    process.exitCode = 1;
    return;
  }

  console.log('\nAsking the register');
  addresses.forEach((a) => console.log(`  address   ${a}`));
  if (supplier) console.log(`  supplier  ${supplier}`);

  const out = await register.lookup({ addresses, supplier });
  console.log('\nAnswer');
  console.log('  ' + JSON.stringify(out));

  // The three outcomes call for three different fixes, which is the whole
  // reason they are kept apart in lib/premisesRegister.js.
  console.log('');
  if (out.found) {
    console.log(`  The register knows this premises. WazzOCR would create the bill in`);
    console.log(`  ${out.tenantCode || out.tenantId}, filed under "${out.contactName}".`);
    console.log('');
    console.log('  If a real bill still goes elsewhere, the address the AI extracted is not');
    console.log('  this one. Check the "addresses" it returned before blaming the rule.');
  } else if (out.unavailable) {
    console.log(`  Bills Hub could not be asked: ${out.reason}`);
    console.log('');
    console.log('  401 means BILLHUB_TOKEN here does not equal BILLHUB_SERVICE_TOKEN in');
    console.log('  Bills Hub\'s .env. A timeout or a DNS error means the URL is wrong or');
    console.log('  Bills Hub is down. Either way the bill is filed by name matching.');
    process.exitCode = 1;
  } else {
    console.log('  Bills Hub was asked and has no row for that address.');
    console.log('');
    console.log('  Check the address on the rule reads as the bill prints it. Matching');
    console.log('  ignores case and punctuation but not a changed, missing or extra word,');
    console.log('  and the rule\'s address must appear INSIDE the one sent up.');
    process.exitCode = 1;
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
