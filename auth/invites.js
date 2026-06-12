// One-time tokens for invites and password resets, delivered over WhatsApp.
// The link carries the raw token; the DB stores only its hash.
const db = require('../db');
const users = require('../models/users');
const wazzup = require('../lib/wazzup');
const { randomToken, sha256hex } = require('../lib/tokens');

const DEFAULT_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS || 72);
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || '';

async function createToken(userId, type, ttlHours = DEFAULT_TTL_HOURS) {
  const raw = randomToken(24);
  const expiresAt = new Date(Date.now() + ttlHours * 3600000);
  await db.execute(
    'INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [userId, type, sha256hex(raw), expiresAt]
  );
  return raw;
}

// Validates and single-use-consumes a token. Returns the user_id, or null.
async function consumeToken(rawToken, type) {
  if (!rawToken) return null;
  const row = await db.getOne(
    `SELECT id, user_id FROM auth_tokens
     WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > NOW()`,
    [sha256hex(rawToken), type]
  );
  if (!row) return null;
  await db.execute('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return row.user_id;
}

function buildLink(type, rawToken) {
  const page = type === 'password_reset' ? 'reset.html' : 'claim.html';
  const base = PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/${page}?token=${rawToken}`;
}

// Creates an invite token and WhatsApps the claim link to the user's phone via
// the FusionETA system channel. Returns { link, sent }.
async function sendInvite(userId, { appName = 'WazzOCR' } = {}) {
  const user = await users.getById(userId);
  if (!user) throw new Error('User not found.');
  if (!user.phone_number) throw new Error('User has no phone number for the WhatsApp invite.');
  const raw = await createToken(userId, 'invite');
  const link = buildLink('invite', raw);
  const text =
    `Hi${user.name ? ' ' + user.name : ''}, you have been set up on ${appName}.\n\n` +
    `Tap to log in or set your password:\n${link}\n\n` +
    `This link expires in ${DEFAULT_TTL_HOURS} hours.`;
  const sent = await wazzup.sendSystemMessage(user.phone_number, text);
  return { link, sent };
}

async function sendPasswordReset(userId, { appName = 'WazzOCR' } = {}) {
  const user = await users.getById(userId);
  if (!user) throw new Error('User not found.');
  if (!user.phone_number) throw new Error('User has no phone number for the reset link.');
  const raw = await createToken(userId, 'password_reset', 2); // short TTL for resets
  const link = buildLink('password_reset', raw);
  const text = `Your ${appName} password reset link (valid 2 hours):\n${link}`;
  const sent = await wazzup.sendSystemMessage(user.phone_number, text);
  return { link, sent };
}

module.exports = { createToken, consumeToken, buildLink, sendInvite, sendPasswordReset };
