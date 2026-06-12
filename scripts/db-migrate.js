// Applies db/schema.sql to the configured MySQL database (verified TLS).
// Usage: node scripts/db-migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const caPath = process.env.DB_CA_CERT;
  if (!caPath || !fs.existsSync(caPath)) {
    console.error('Missing CA cert. Set DB_CA_CERT in .env.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 25060),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
    multipleStatements: true
  });
  await conn.query(sql);
  const [tables] = await conn.query('SHOW TABLES');
  console.log(`Schema applied. ${tables.length} tables:`);
  for (const t of tables) console.log('  -', Object.values(t)[0]);
  await conn.end();
})().catch((err) => {
  console.error('Migration FAILED:', err.code || '', err.message);
  process.exit(1);
});
