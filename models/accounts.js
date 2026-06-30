// Account (customer workspace) data access.
const db = require('../db');

async function create({ name, status = 'active', plan = 'trial', setupComplete = true, aiProvider = 'gemini', aiModel = 'gemini-2.5-flash', autoCreateBills = false } = {}) {
  if (!name) throw new Error('Account name is required.');
  return db.insert(
    'INSERT INTO accounts (name, status, plan, setup_complete, ai_provider, ai_model, auto_create_bills) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, status, plan === 'paid' ? 'paid' : 'trial', setupComplete ? 1 : 0, aiProvider, aiModel, autoCreateBills ? 1 : 0]
  );
}

function getById(id) {
  return db.getOne('SELECT * FROM accounts WHERE id = ?', [id]);
}

function list() {
  return db.query('SELECT * FROM accounts ORDER BY created_at DESC');
}

// Update a whitelisted set of fields. Returns affectedRows.
async function update(id, fields = {}) {
  const allowed = {
    name: 'name',
    status: 'status',
    plan: 'plan',
    setupComplete: 'setup_complete',
    aiProvider: 'ai_provider',
    aiModel: 'ai_model',
    aiPromptAddon: 'ai_prompt_addon',
    autoCreateBills: 'auto_create_bills'
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (key in fields) {
      sets.push(`${col} = ?`);
      if (key === 'autoCreateBills' || key === 'setupComplete') params.push(fields[key] ? 1 : 0);
      else if (key === 'plan') params.push(fields[key] === 'paid' ? 'paid' : 'trial');
      else params.push(fields[key]);
    }
  }
  if (!sets.length) return 0;
  params.push(id);
  const res = await db.execute(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  return res.affectedRows;
}

module.exports = { create, getById, list, update };
