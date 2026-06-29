// Trial-plan helpers. The trial plan shares one Wazzup channel (pointer stored in
// app_settings); trial accounts route by sender phone on that channel.
const appSettings = require('../models/appSettings');
const wazzupChannels = require('../models/wazzupChannels');

const TRIAL_CHANNEL_KEY = 'trial_default_channel_id';

function getTrialChannelId() {
  return appSettings.get(TRIAL_CHANNEL_KEY, '');
}
function setTrialChannelId(channelId) {
  return appSettings.set(TRIAL_CHANNEL_KEY, String(channelId || '').trim());
}

// wazzup_channels.id (db id) of the configured trial channel, or null.
async function trialChannelDbId() {
  const cid = await getTrialChannelId();
  if (!cid) return null;
  const ch = await wazzupChannels.getByChannelId(cid);
  return ch ? ch.id : null;
}

// Which channel an account's phone-list rows attach to:
//   • trial account → the shared trial channel
//   • paid account  → its own (first) channel
// Returns a wazzup_channels.id (db id) or null if none is available yet.
async function targetChannelForAccount(account) {
  if (!account) return null;
  if (account.plan === 'trial') return trialChannelDbId();
  const chans = await wazzupChannels.listByAccount(account.id);
  return chans.length ? chans[0].id : null;
}

module.exports = {
  TRIAL_CHANNEL_KEY,
  getTrialChannelId,
  setTrialChannelId,
  trialChannelDbId,
  targetChannelForAccount,
};
