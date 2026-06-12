// Quick connectivity check for the DigitalOcean MySQL database.
// Usage: node scripts/db-test.js
// Requires DB_CA_CERT in .env pointing to DigitalOcean's CA certificate file
// (Databases -> your cluster -> Connection details -> Download CA certificate).
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

(async () => {
  const caPath = process.env.DB_CA_CERT;
  if (!caPath || !fs.existsSync(caPath)) {
    console.error('Missing CA cert. Set DB_CA_CERT in .env to the DigitalOcean CA certificate path.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 25060),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } // verified TLS
  });
  const [verRows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db, NOW() AS now');
  console.log('Connected OK:', verRows[0]);
  const [tables] = await conn.query('SHOW TABLES');
  console.log(`Existing tables: ${tables.length}`);
  for (const t of tables) console.log('  -', Object.values(t)[0]);
  await conn.end();
})().catch((err) => {
  console.error('DB connection FAILED:', err.code || '', err.message);
  process.exit(1);
});
