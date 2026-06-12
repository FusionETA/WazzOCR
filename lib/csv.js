// Minimal CSV parser supporting double-quoted fields (handles commas and quotes
// inside fields, e.g. "Printing, Stationery & Postages").
function parse(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// Parse a chart-of-accounts CSV into [{code, name, category}]. Detects an
// optional header row and maps columns flexibly (code/number, name/description,
// category/type).
function parseCoa(text) {
  const rows = parse(text);
  if (!rows.length) return [];
  const header = rows[0].map((x) => String(x).trim().toLowerCase());
  let start = 0;
  const idx = { code: 0, name: 1, category: 2 };
  const looksLikeHeader = header.some((h) => /code|account number|number|name|description|particular|categor|type|class/.test(h));
  if (looksLikeHeader) {
    start = 1;
    const find = (re, fb) => { const i = header.findIndex((h) => re.test(h)); return i < 0 ? fb : i; };
    idx.code = find(/code|account number|^number$/, 0);
    idx.name = find(/name|description|particular/, 1);
    idx.category = header.findIndex((h) => /categor|type|class/.test(h)); // -1 if absent
  }
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const code = String(r[idx.code] || '').trim();
    const name = String(r[idx.name] || '').trim();
    const category = idx.category >= 0 ? String(r[idx.category] || '').trim() : '';
    if (code && name) out.push({ code, name, category });
  }
  return out;
}

module.exports = { parse, parseCoa };
