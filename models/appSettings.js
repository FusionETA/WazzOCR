// Global key/value settings (admin-managed). Holds the general base AI prompt.
const db = require('../db');

async function get(key, fallback = null) {
  const row = await db.getOne('SELECT value FROM app_settings WHERE `key` = ?', [key]);
  return row ? row.value : fallback;
}

async function set(key, value) {
  await db.execute(
    'INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, value]
  );
}

module.exports = { get, set };
