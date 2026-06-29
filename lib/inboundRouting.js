// Resolve an inbound WhatsApp message to the account it should be processed for,
// and decide whether the sender is authorised.
//
// Rules (a single unified path covers normal + trial channels):
//   • Channel not registered in the DB → allowed, no account context (the legacy
//     "global Xero path" — unchanged so unregistered/test channels still work).
//   • Channel with restriction OFF → allowed; routes to the channel's owner account
//     (exactly the legacy behaviour).
//   • Channel with restriction ON  → the sender phone must appear in this channel's
//     phone map; the matched row's account is the routing target. No match → BLOCKED.
//
// The shared trial channel simply runs with restriction ON and many accounts' phones
// mapped to it, so a trial sender's phone resolves to their own trial account.
const wazzupChannels = require('../models/wazzupChannels');
const channelPhones = require('../models/channelPhones');

// Returns { allowed, accountId, channelDbId, known } where:
//   allowed     — false ONLY for a known restricted channel whose sender isn't mapped
//   accountId   — the account to process for (null = legacy global path)
//   channelDbId — the wazzup_channels.id, when known
//   known       — whether the channel exists in the DB
async function resolveInbound({ channelId, phone }) {
  const id = String(channelId || '').trim();
  if (!id) return { allowed: true, accountId: null, channelDbId: null, known: false };

  const ch = await wazzupChannels.getByChannelId(id);
  if (!ch) return { allowed: true, accountId: null, channelDbId: null, known: false };

  // Open channel — unchanged legacy routing to the owner account.
  if (!ch.phone_restriction_enabled) {
    return { allowed: true, accountId: ch.account_id, channelDbId: ch.id, known: true };
  }

  // Restricted channel — the sender must be mapped; the mapping decides the account.
  const mapped = await channelPhones.resolveAccount(ch.id, phone);
  if (!mapped) return { allowed: false, accountId: null, channelDbId: ch.id, known: true };
  return { allowed: true, accountId: mapped.account_id, channelDbId: ch.id, known: true };
}

module.exports = { resolveInbound };
