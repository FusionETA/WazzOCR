// Creates the first FusionETA super admin (no account, can see everything).
// Usage: node scripts/create-admin.js <email> <password> ["Full Name"]
require('dotenv').config();
const db = require('../db');
const users = require('../models/users');
const { hashPassword } = require('../auth/passwords');

(async () => {
  const [, , email, password, name] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js <email> <password> ["Full Name"]');
    process.exit(1);
  }
  const existing = await users.getByEmail(email);
  if (existing) {
    console.error('A user with that email already exists (id=' + existing.id + ').');
    process.exit(1);
  }
  const id = await db.insert(
    `INSERT INTO users (account_id, email, name, role, is_super_admin, status)
     VALUES (NULL, ?, ?, 'owner', 1, 'active')`,
    [String(email).toLowerCase(), name || null]
  );
  await users.setPasswordHash(id, await hashPassword(password));
  console.log(`Super admin created: id=${id} email=${email}`);
  await db.close();
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
