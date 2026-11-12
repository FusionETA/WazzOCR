// Email channel UI for the account dashboard: the Inbox tab and the
// Settings → Email channel card. Loaded by account.html, which calls
// EmailInbox.init() once the page has rendered. Uses the page's esc(),
// CONNECTIONS, __searchDropdown and showToast.
(function () {
  const S = { data: null, filter: 'all', search: '', sel: null, timer: null, settings: null };

  const css = `
  .ib-todo{border-radius:12px;padding:1.1rem 1.2rem;display:flex;flex-direction:column;gap:.75rem;flex:1 1 420px;min-width:0}
  .ib-todo.warn{background:var(--warn-bg);border:1px solid #F5E2BF;border-left:4px solid var(--warn)}
  .ib-todo.ok{background:var(--ok-bg);border:1px solid #CDEED8;border-left:4px solid var(--ok)}
  .ib-chip{display:inline-flex;gap:.3rem;align-items:center;background:#fff;border:1px solid #F0E3C8;border-radius:999px;padding:.25rem .7rem;font-size:.8rem;color:var(--text)}
  .ib-todo-row{display:flex;align-items:center;gap:.75rem;width:100%;text-align:left;background:#fff;border:1px solid #F0E3C8;border-radius:9px;padding:.6rem .75rem;min-height:46px;cursor:pointer;font:inherit;color:var(--text)}
  .ib-todo-row:hover{border-color:var(--warn)}
  .ib-kind{font-size:.66rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--warn);white-space:nowrap;min-width:118px}
  .ib-go{margin-left:auto;font-size:.78rem;font-weight:700;color:var(--navy);white-space:nowrap}
  .ib-ellip{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.85rem}
  .ib-bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:#EEF2F6}
  .ib-legend{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin-top:.5rem;font-size:.78rem;color:#475467}
  .ib-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
  .ib-subj{background:none;border:0;padding:0;font:inherit;font-weight:600;color:var(--ink);cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;text-align:left}
  .ib-subj:hover{color:var(--blue);text-decoration:underline}
  .ib-sub{display:block;color:var(--muted);font-size:.75rem;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
  .ib-next{font-family:var(--font);font-size:.76rem;font-weight:700;padding:.35rem .7rem;border-radius:7px;border:1px solid var(--warn);background:#fff;color:var(--warn);cursor:pointer;white-space:nowrap}
  .ib-next:hover{background:var(--warn-bg)}
  .table tbody tr.ib-act td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
  .table tbody tr.ib-sel td{background:#F0F4FF}
  .ib-drawer-bg{position:fixed;inset:0;background:rgba(15,45,74,.35);z-index:40}
  .ib-drawer{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:100%;background:#fff;z-index:41;overflow-y:auto;padding:1.4rem 1.5rem;box-shadow:var(--shadow-lg)}
  .ib-att{border:1px solid var(--line);border-radius:9px;padding:.8rem .9rem;background:#FAFBFE}
  .ib-tab-badge{display:inline-flex;min-width:18px;height:18px;padding:0 5px;margin-left:4px;border-radius:999px;background:var(--accent);color:#fff;font-size:.7rem;align-items:center;justify-content:center}`;

  const LABEL = {
    created: ['success', 'bill created'],
    pending: ['pending', 'choose Xero org'],
    failed: ['failed', 'failed'],
    duplicate: ['skipped', 'already in Xero'],
    dismissed: ['skipped', 'dismissed'],
    queued: ['neutral', 'reading…'],
    processing: ['neutral', 'reading…'],
    none: ['skipped', 'nothing to bill']
  };

  const money = (n, cur) => (cur || 'MYR') + ' ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? '-' : d.toLocaleDateString(); };
  const fmtTime = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  // account.html declares CONNECTIONS with `let`, so it is a global binding but not a window property.
  const conns = () => (typeof CONNECTIONS !== 'undefined' && Array.isArray(CONNECTIONS) ? CONNECTIONS : []);
  const isXeroRejected = (a) => /^Xero rejected/.test(a.message || '');

  // One row per email; its status is the most urgent of its attachments.
  function rowOf(m) {
    const atts = m.attachments || [];
    const pick = (st) => atts.find((a) => a.status === st);
    const act = atts.find((a) => a.needs_action);
    let status = 'none';
    if (atts.length) {
      status = 'created';
      for (const k of ['pending', 'failed', 'queued', 'processing', 'duplicate', 'dismissed']) if (pick(k)) { status = k; break; }
      if (status === 'dismissed' && pick('created')) status = 'created';
    }
    const created = atts.filter((a) => a.status === 'created');
    const orgs = [...new Set(atts.map((a) => a.xero_tenant_name).filter(Boolean))];
    // An email whose files were all refused reads as "nothing to bill", with why.
    let msg = m.skip_reason || (!atts.length && m.ignored_files ? 'Nothing to process. ' + m.ignored_files : '');
    if (!msg) {
      if (status === 'queued' || status === 'processing') msg = 'Reading the document…';
      else if (status === 'duplicate') msg = 'Already in Xero — nothing to do';
      else if (status === 'dismissed') msg = 'Dismissed';
      else if (status === 'created') msg = atts.some((a) => a.resolved_by_user && a.status === 'created') ? 'Resolved by you' : 'Done automatically';
      else msg = (act && act.message) || '';
    }
    const bucket = act ? 'action' : created.length ? 'created' : (status === 'queued' || status === 'processing') ? 'wait' : 'none';
    return {
      m, atts, status, act, msg, bucket,
      byUser: atts.some((a) => a.resolved_by_user),
      org: orgs.length ? orgs[0] + (orgs.length > 1 ? ' +' + (orgs.length - 1) : '') : '-',
      xeroUrl: (created[0] && created[0].xero_url) || ''
    };
  }

  function cta(a) {
    if (!a) return '';
    if (a.status === 'pending') return isXeroRejected(a) ? 'Review' : 'Choose org';
    return 'Review';
  }
  function kind(a) {
    if (a.status === 'pending') return isXeroRejected(a) ? 'Xero rejected' : 'Choose Xero org';
    return 'Failed to read';
  }

  // ── Inbox tab ─────────────────────────────────────────────────────────────

  function panelHtml() {
    return `<div class="card"><div id="ibRoot"><div class="empty">Loading…</div></div></div>`;
  }

  async function load(quiet) {
    try {
      const r = await fetch('/api/me/email/inbox');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load the inbox.');
      S.data = await r.json();
      render();
      updateBadge();
      updateHero();
    } catch (e) {
      if (!quiet) document.getElementById('ibRoot').innerHTML = `<div class="msg err" style="display:block">${esc(e.message)}</div>`;
    }
    // Keep refreshing while anything is still being read.
    clearTimeout(S.timer);
    const reading = S.data && S.data.stats && S.data.stats.reading;
    S.timer = setTimeout(() => { if (isActive()) load(true); }, reading ? 8000 : 60000);
  }

  function isActive() {
    const p = document.getElementById('panel-inbox');
    return p && p.classList.contains('active') && !document.hidden;
  }

  function updateBadge() {
    const b = document.querySelector('.tabs button[data-tab="inbox"]');
    if (!b || !S.data) return;
    const n = S.data.stats.needsAction;
    b.innerHTML = 'Email' + (n ? ` <span class="ib-tab-badge">${n}</span>` : '');
  }

  // Adds "· Email N" to the hero line, so the month split is visible at a glance.
  function updateHero() {
    const line = document.querySelector('.card.hero .muted');
    if (!line || !S.data) return;
    if (!line.dataset.base) line.dataset.base = line.textContent;
    const n = S.data.stats.billsMonth;
    line.textContent = line.dataset.base + (n ? ` · ${n} by email this month` : '');
  }

  function render() {
    const root = document.getElementById('ibRoot');
    if (!root || !S.data) return;
    const { stats, channel } = S.data;
    const rows = S.data.messages.map(rowOf);
    const todo = [];
    rows.forEach((r) => r.atts.filter((a) => a.needs_action).forEach((a) => todo.push({ r, a })));
    // How many of each kind, so the card stays one size however many are open.
    const kindCount = new Map();
    todo.forEach(({ a }) => kindCount.set(kind(a), (kindCount.get(kind(a)) || 0) + 1));
    const kinds = [...kindCount];

    const flow = {
      auto: rows.filter((r) => r.bucket === 'created' && !r.byUser).length,
      you: rows.filter((r) => r.bucket !== 'action' && r.byUser && r.bucket === 'created').length,
      open: rows.filter((r) => r.bucket === 'action').length,
      wait: rows.filter((r) => r.bucket === 'wait').length
    };
    flow.none = rows.length - flow.auto - flow.you - flow.open - flow.wait;
    const pct = (n) => rows.length ? (n * 100 / rows.length).toFixed(1) : 0;

    const q = S.search.trim().toLowerCase();
    const visible = rows.filter((r) => {
      if (S.filter === 'action' && r.bucket !== 'action') return false;
      if (S.filter === 'created' && r.bucket !== 'created') return false;
      if (S.filter === 'none' && !(r.bucket === 'none' || r.bucket === 'wait')) return false;
      if (!q) return true;
      return [r.m.from_name, r.m.from_email, r.m.subject, r.org, ...r.atts.map((a) => (a.supplier || '') + ' ' + (a.invoice_no || ''))]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });

    const addr = channel.gmailAddress
      ? `<span class="muted">Email bills to</span> <span style="font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--navy);font-size:.88rem">${esc(channel.gmailAddress)}</span>`
      : `<span class="muted">Set the Gmail address under Settings → Email channel</span>`;
    const last = channel.lastHeartbeatAt
      ? `<span class="muted" style="font-size:.8rem" title="${esc(toDate(channel.lastHeartbeatAt).toLocaleString())}">· checked ${esc(ago(channel.lastHeartbeatAt))}</span>`
      : `<span class="badge pending" title="The Gmail script has not reported in yet">not connected</span>`;

    const todoCard = todo.length ? `
      <section class="ib-todo warn" aria-label="Needs your action">
        <div style="display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap">
          <span style="font-family:var(--head);font-size:2.4rem;font-weight:800;color:var(--warn);line-height:1">${todo.length}</span>
          <div><div style="font-weight:800;color:var(--ink)">${todo.length === 1 ? 'bill needs your action' : 'bills need your action'}</div>
          <div class="muted" style="font-size:.8rem">${stats.needsActionValue ? 'Worth ' + esc(money(stats.needsActionValue)) + ' · ' : ''}not in Xero yet</div></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem">
          ${kinds.map(([k, n]) => `<span class="ib-chip"><b>${n}</b> ${esc(k.toLowerCase())}</span>`).join('')}
        </div>
        <div><button type="button" class="btn btn-primary btn-sm" onclick="EmailInbox.filter('action')">Review ${todo.length === 1 ? 'it' : 'them'} →</button></div>
      </section>` : `
      <section class="ib-todo ok" aria-label="Needs your action">
        <div style="display:flex;align-items:center;gap:.8rem">
          <span style="width:44px;height:44px;border-radius:50%;background:var(--ok);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
          <div><div style="font-weight:800;color:var(--ok);font-size:1.1rem">All clear</div>
          <div class="muted" style="font-size:.85rem">Nothing is waiting on you. New emails are processed automatically.</div></div>
        </div>
      </section>`;

    root.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between;margin-bottom:1.1rem">
        <h2 style="margin:0">Mailbox activity <span class="title-count">${rows.length}</span></h2>
        <div style="display:flex;flex-wrap:wrap;gap:.6rem;align-items:center">${addr} ${last}
          <button class="btn btn-ghost btn-sm" type="button" onclick="EmailInbox.load()">Refresh</button></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:stretch;margin-bottom:1.1rem">
        ${todoCard}
        <div class="stat-grid" style="flex:1 1 440px;min-width:0;grid-template-columns:repeat(2,minmax(0,1fr))">
          <div class="stat-tile ok"><span class="t-num">${stats.billsMonth}</span><span class="t-label">Bills from email · this month</span><span class="muted" style="font-size:.76rem">${stats.billsDay} created in the last 24h</span></div>
          <div class="stat-tile"><span class="t-num" style="font-size:1.45rem;padding:.25rem 0">${esc(money(stats.valueMonth))}</span><span class="t-label">Sent to Xero · this month</span><span class="muted" style="font-size:.76rem">from email bills only</span></div>
          <div class="stat-tile"><span class="t-num">${stats.reading}</span><span class="t-label">Reading now</span><span class="muted" style="font-size:.76rem">usually under a minute</span></div>
          <div class="stat-tile"><span class="t-num">${stats.resolvedDay}</span><span class="t-label">Resolved by you · 24h</span><span class="muted" style="font-size:.76rem">${flow.auto + flow.none} of ${rows.length} emails needed nothing from you</span></div>
        </div>
      </div>
      ${rows.length ? `<div style="margin-bottom:1.2rem">
        <div class="ib-bar" aria-hidden="true">
          <div style="width:${pct(flow.auto)}%;background:var(--ok)"></div><div style="width:${pct(flow.you)}%;background:var(--blue)"></div>
          <div style="width:${pct(flow.open)}%;background:#E59E3B"></div><div style="width:${pct(flow.wait)}%;background:#94A3B8"></div>
          <div style="width:${pct(flow.none)}%;background:#D5DCE6"></div></div>
        <div class="ib-legend">
          <span><i style="background:var(--ok)"></i>Billed automatically <b>${flow.auto}</b></span>
          <span><i style="background:var(--blue)"></i>Resolved by you <b>${flow.you}</b></span>
          <span><i style="background:#E59E3B"></i>Needs action <b>${flow.open}</b></span>
          <span><i style="background:#94A3B8"></i>Reading <b>${flow.wait}</b></span>
          <span><i style="background:#D5DCE6"></i>Nothing to bill <b>${flow.none}</b></span>
        </div></div>` : ''}
      <div class="filterbar">
        <div class="fb-field fb-grow"><label for="ibSearch">Search</label><input type="search" id="ibSearch" placeholder="Sender, subject, invoice or Xero org…" value="${esc(S.search)}"></div>
        <div class="fb-field" style="min-width:200px"><label for="ibFilter">Show</label>
          <select id="ibFilter">
            ${[['all', 'All emails'], ['action', 'Needs action'], ['created', 'Bill created'], ['none', 'Nothing to bill']].map(([v, l]) => `<option value="${v}"${S.filter === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select></div>
        <button class="btn btn-ghost btn-sm" type="button" onclick="EmailInbox.clear()">Clear</button>
      </div>
      ${visible.length ? `<div style="overflow-x:auto"><table class="table fixed" style="min-width:1040px">
        <colgroup><col style="width:100px"><col style="width:200px"><col style="width:220px"><col style="width:60px"><col style="width:150px"><col style="width:190px"><col style="width:64px"><col></colgroup>
        <thead><tr><th>Date</th><th>Sender</th><th>Subject</th><th>Files</th><th>Result</th><th>Xero org</th><th>Xero</th><th>Next step</th></tr></thead>
        <tbody>${visible.map((r) => {
          const [cls, label] = LABEL[r.status] || LABEL.none;
          const when = r.m.received_at;
          return `<tr class="${r.act ? 'ib-act' : ''} ${S.sel === r.m.id ? 'ib-sel' : ''}">
            <td class="num-cell" style="color:var(--muted)">${esc(fmtDate(when))}<span class="ib-sub">${esc(fmtTime(when))}</span></td>
            <td title="${esc(r.m.from_email || '')}">${esc(r.m.from_name || r.m.from_email || '-')}<span class="ib-sub">${esc(r.m.from_name ? r.m.from_email || '' : '')}</span></td>
            <td><button type="button" class="ib-subj" onclick="EmailInbox.open(${r.m.id})" title="${esc(r.m.subject || '')}">${esc(r.m.subject || '(no subject)')}</button></td>
            <td>${r.atts.length ? new Set(r.atts.map((a) => a.file_name)).size : '-'}</td>
            <td><span class="badge ${cls}">${esc(label)}</span></td>
            <td title="${esc(r.org)}">${esc(r.org)}</td>
            <td>${r.xeroUrl ? `<a href="${esc(r.xeroUrl)}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="muted">-</span>'}</td>
            <td>${r.act ? `<button type="button" class="ib-next" onclick="EmailInbox.open(${r.m.id})">${esc(cta(r.act))}</button>` : `<span class="muted" title="${esc(r.msg)}">${esc(r.msg)}</span>`}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : `<div class="empty">${rows.length ? 'No emails match.' : 'No emails yet. Everything that reaches the Gmail mailbox appears here.'}</div>`}
      <p class="muted" style="margin:1rem 0 0;font-size:.8rem">Every email that reaches the mailbox appears here, including ones with nothing to bill. Click a subject to see each attachment.</p>`;

    const s = document.getElementById('ibSearch');
    let t;
    s.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.search = s.value; render(); const n = document.getElementById('ibSearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
    document.getElementById('ibFilter').onchange = (e) => { S.filter = e.target.value; render(); };
    if (S.sel) renderDrawer();
  }

  // DB times arrive as ISO strings in UTC; a bare "YYYY-MM-DD HH:MM:SS" is UTC too.
  function toDate(v) {
    const str = String(v || '');
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
  }
  function ago(utc) {
    const d = toDate(utc);
    const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  // ── Detail drawer ─────────────────────────────────────────────────────────

  function renderDrawer() {
    closeDrawerEls();
    const m = S.data && S.data.messages.find((x) => x.id === S.sel);
    if (!m) return;
    const r = rowOf(m);
    const [cls, label] = LABEL[r.status] || LABEL.none;
    const bg = document.createElement('div');
    bg.className = 'ib-drawer-bg'; bg.id = 'ibDrawerBg'; bg.onclick = close;
    const d = document.createElement('aside');
    d.className = 'ib-drawer'; d.id = 'ibDrawer'; d.setAttribute('aria-label', 'Email detail');
    d.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start">
        <h2 style="margin:0;font-size:1.05rem">${esc(m.subject || '(no subject)')}</h2>
        <button class="copy-btn" type="button" onclick="EmailInbox.close()" aria-label="Close">✕</button></div>
      <div style="margin:.9rem 0 1rem">
        <div class="kv"><div class="k" style="min-width:90px">From</div><div>${esc(m.from_name ? m.from_name + ' · ' : '')}${esc(m.from_email || '-')}</div></div>
        <div class="kv"><div class="k" style="min-width:90px">Received</div><div>${esc(new Date(m.received_at).toLocaleString())}</div></div>
        <div class="kv"><div class="k" style="min-width:90px">Result</div><div><span class="badge ${cls}">${esc(label)}</span></div></div>
      </div>
      <h3 style="margin:0 0 .6rem">Attachments</h3>
      ${r.atts.length ? '' : `<div class="muted" style="padding:.8rem;border:1.5px dashed var(--line);border-radius:9px">${esc(m.skip_reason || (m.ignored_files ? 'Nothing to process.' : 'No attachment.'))}</div>`}
      <div style="display:flex;flex-direction:column;gap:.7rem">${r.atts.map(attHtml).join('')}</div>
      ${m.ignored_files ? `<h3 style="margin:1rem 0 .4rem">Not processed</h3>
        <div class="muted" style="font-size:.8rem;padding:.7rem .8rem;border:1px solid var(--line);border-radius:9px;background:#FAFBFE">
          ${m.ignored_files.replace(/^Ignored:\s*/, '').split(/;\s*/).map((t) => `<div>• ${esc(t)}</div>`).join('')}
          <div style="margin-top:.4rem">Only PDF, JPG and PNG attachments are read. Pictures that are part of the email itself (logos, icons) and other file types are never sent to the AI.</div></div>` : ''}`;
    document.body.appendChild(bg);
    document.body.appendChild(d);
    r.atts.filter((a) => a.status === 'pending').forEach((a) => {
      const items = conns().map((c) => ({ value: c.xero_tenant_id || c.tenantId, label: c.tenant_name || c.tenantName || c.xero_tenant_id }));
      if (items.length && document.getElementById('ibOrg-' + a.id)) window.__searchDropdown('ibOrg-' + a.id, items, { placeholder: 'Choose organisation' });
    });
  }

  function attHtml(a) {
    const [cls, label] = LABEL[a.status] || LABEL.none;
    const note = a.status === 'created' && a.resolved_by_user ? 'Resolved by you.' : a.message;
    const pending = a.status === 'pending';
    return `<div class="ib-att">
      <div style="display:flex;justify-content:space-between;gap:.5rem;align-items:center">
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:.8rem;font-weight:600;overflow-wrap:anywhere">${esc(a.file_name)}${a.bill_index ? ` <span class="muted">(bill ${a.bill_index + 1})</span>` : ''}</span>
        <span class="badge ${cls}">${esc(label)}</span></div>
      <div class="grid2" style="margin-top:.6rem;font-size:.8rem;gap:.4rem .75rem">
        <div><div class="muted" style="font-size:.72rem">Supplier</div><b>${esc(a.supplier || '-')}</b></div>
        <div><div class="muted" style="font-size:.72rem">Invoice</div>${esc(a.invoice_no || '-')}</div>
        <div><div class="muted" style="font-size:.72rem">Total</div><b>${a.total != null ? esc(money(a.total, a.currency)) : '-'}</b></div>
        <div><div class="muted" style="font-size:.72rem">Xero org</div>${esc(a.xero_tenant_name || (pending ? 'Not sure' : '-'))}</div>
      </div>
      ${note ? `<div style="margin-top:.6rem;font-size:.8rem;color:#475467;background:#fff;border:1px solid var(--line);border-radius:7px;padding:.5rem .65rem">${esc(note)}</div>` : ''}
      ${pending && a.bill_id ? `<div class="field" style="margin-top:.7rem"><label>Create this bill in</label>
          ${conns().length ? `<div id="ibOrg-${a.id}"></div>` : '<div class="muted">No Xero organisation connected.</div>'}</div>
        <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.4rem">
          <button class="btn btn-primary btn-sm" type="button" onclick="EmailInbox.resolve(${a.id},${a.bill_id},this)">Create bill in Xero</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="EmailInbox.dismiss(${a.id},this)">Not a bill — dismiss</button></div>` : ''}
      ${a.status === 'failed' && a.can_retry ? `<div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.7rem">
          <button class="btn btn-primary btn-sm" type="button" onclick="EmailInbox.retry(${a.id},this)">Process again</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="EmailInbox.dismiss(${a.id},this)">Not a bill — dismiss</button></div>` : ''}
      ${a.status === 'created' && a.xero_url ? `<div style="margin-top:.6rem"><a class="btn btn-ghost btn-sm" href="${esc(a.xero_url)}" target="_blank" rel="noopener">Open in Xero ↗</a></div>` : ''}
      <div class="msg" id="ibMsg-${a.id}"></div>
    </div>`;
  }

  function closeDrawerEls() {
    ['ibDrawerBg', 'ibDrawer'].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
  }
  function open(id) { S.sel = id; render(); }
  function close() { S.sel = null; closeDrawerEls(); render(); }

  // Something changed a bill: refresh this tab, the other tables and the hero.
  async function afterChange(text) {
    if (window.showToast && text) window.showToast(text, true);
    await load(true);
    if (window.loadPending) window.loadPending();
    if (window.loadBills) window.loadBills();
    fetch('/api/me/summary').then((r) => r.json()).then((s) => {
      const n = document.querySelector('.stat .num');
      if (n) n.textContent = s.successThisMonth != null ? s.successThisMonth : s.successCount;
    }).catch(() => {});
  }

  async function act(url, body, btn, attId) {
    const msg = document.getElementById('ibMsg-' + attId);
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed.');
      return true;
    } catch (e) {
      if (msg) { msg.className = 'msg err'; msg.textContent = e.message; }
      if (btn) btn.disabled = false;
      return false;
    }
  }

  async function resolve(attId, billId, btn) {
    const dd = document.getElementById('ibOrg-' + attId);
    const tenantId = dd && dd.value ? dd.value() : '';
    if (!tenantId) { const m = document.getElementById('ibMsg-' + attId); m.className = 'msg err'; m.textContent = 'Choose an organisation.'; return; }
    const org = conns().find((c) => c.xero_tenant_id === tenantId);
    if (await act('/api/me/bills/' + billId + '/resolve', { tenantId }, btn, attId)) {
      await afterChange(`Bill created in ${org ? org.tenant_name : 'Xero'} — 1 fewer to resolve`);
    }
  }
  async function retry(attId, btn) {
    if (await act('/api/me/email/attachments/' + attId + '/retry', {}, btn, attId)) await afterChange('Reading it again…');
  }
  async function dismiss(attId, btn) {
    if (!confirm('Dismiss this bill? It will not be created in Xero.')) return;
    if (await act('/api/me/email/attachments/' + attId + '/dismiss', {}, btn, attId)) await afterChange('Dismissed — 1 fewer to resolve');
  }

  // ── Settings → Email channel ──────────────────────────────────────────────

  function settingsCardHtml() {
    return `<div class="card" id="emailCard"><h2>Email channel</h2><div id="emailCardBody" class="muted">Loading…</div></div>`;
  }

  // Google's daily trigger allowance, as used by the Gmail script over the last
  // 24 hours (each run reports its duration on the next heartbeat).
  function usageHtml(u) {
    if (!u) return '';
    if (!u.runs) {
      return `<p class="muted" style="font-size:.78rem;margin:.4rem 0 0">Daily Google run time appears here once the updated Gmail script has run a few times.</p>`;
    }
    const limit = u.dailyLimitMinutes || 90;
    const used = u.totalMs / 60000;
    const avgSec = u.totalMs / u.runs / 1000;
    // A new or recently changed script has less than a day of runs; project the
    // average over a full day of every-minute runs as well.
    const projected = avgSec * 1440 / 60;
    const worst = Math.max(used, u.runs < 1300 ? projected : 0);
    const pct = Math.min(100, worst / limit * 100);
    const tone = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)';
    const fmt = (n) => (n < 10 ? n.toFixed(1) : Math.round(n));
    const advice = pct >= 90
      ? ' <b style="color:var(--bad)">Close to Google\'s limit — switch the trigger to every 5 minutes.</b>'
      : pct >= 70 ? ' <b style="color:var(--warn)">Getting close — consider every 5 minutes.</b>' : '';
    return `<div style="margin-top:.7rem" title="Google allows a free Gmail about ${limit} minutes of trigger run time a day. Measured inside the script, so Google's own count runs slightly higher.">
      <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.3rem">
        <span><b>Google run time, last 24h:</b> ${fmt(used)} of ${limit} min</span>
        <span class="muted">${u.runs.toLocaleString()} runs · average ${avgSec.toFixed(1)} s</span></div>
      <div class="ib-bar"><div style="width:${Math.min(100, used / limit * 100).toFixed(1)}%;background:${tone}"></div></div>
      <p class="muted" style="font-size:.76rem;margin:.35rem 0 0">${u.runs < 1300 ? `At this pace a full day of every-minute runs uses about ${fmt(projected)} min.` : 'A full day of runs is counted.'}${advice}</p>
    </div>`;
  }

  // Where the Drive copy stands: waiting files, last save, and what to do when
  // the pasted script is too old to save to Drive.
  function driveHtml(s) {
    const d = s.driveStats;
    if (!s.driveArchive || !d) return '';
    if (s.scriptVersion && s.scriptVersion < '2026-11-10c') {
      return `<p class="muted" style="font-size:.78rem;margin:.4rem 0 0"><b style="color:var(--warn)">Paste the updated Gmail script and run setup once</b> to allow Drive. Until then files wait here (${d.waiting} so far).</p>`;
    }
    const parts = [];
    parts.push(d.savedDay ? `${d.savedDay} saved in the last 24h` : 'Nothing saved in the last 24h');
    if (d.waiting) parts.push(`${d.waiting} waiting for the next run`);
    if (d.processing) parts.push(`${d.processing} still being read`);
    if (d.lastSavedAt) parts.push(`last saved ${ago(d.lastSavedAt)}`);
    return `<p class="muted" style="font-size:.78rem;margin:.4rem 0 0">${esc(parts.join(' · '))}</p>`;
  }

  async function wireSettings() {
    const body = document.getElementById('emailCardBody');
    if (!body) return;
    let s;
    try { s = await (await fetch('/api/me/email/settings')).json(); } catch { body.textContent = 'Could not load.'; return; }
    S.settings = s;
    const connected = Boolean(s.lastHeartbeatAt);
    const outdated = connected && s.scriptVersion !== s.expectedScriptVersion;
    body.className = '';
    body.innerHTML = `
      <label class="switch-row">
        <span class="switch ${s.enabled ? 'is-on' : ''}" id="emSwitch"><input type="checkbox" id="emEnabled" ${s.enabled ? 'checked' : ''} aria-label="Receive bills by email"><span class="switch-track"></span><span class="switch-thumb"></span></span>
        <span class="switch-label">Receive bills by email</span>
        <span class="switch-state ${s.enabled ? 'is-on' : ''}" id="emState">${s.enabled ? 'ON' : 'OFF'}</span>
      </label>
      <p class="muted" style="margin:.8rem 0 .4rem">Anyone can email bills to this Gmail mailbox. Only <b>PDF, JPG and PNG attachments</b> are read — pictures that are part of the email itself (logos, icons) and other file types are ignored. Bills use the same AI, chart of accounts and Xero posting as WhatsApp, and count towards the same monthly total.</p>
      <div class="field"><label for="emGmail">Gmail address</label><input id="emGmail" type="email" placeholder="yourcompanywazzocr@gmail.com" value="${esc(s.gmailAddress)}"></div>
      <div class="field"><label for="emGmailPw">Gmail password</label>
        <div class="pw-wrap"><input id="emGmailPw" type="password" autocomplete="off" placeholder="Password for this Gmail" value="${esc(s.gmailPassword)}">
          <button class="pw-toggle" type="button" id="emPwToggle" aria-label="Show password">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button></div></div>
      <p class="muted" style="font-size:.76rem;margin:.2rem 0 0">Kept here so your team has the login in one place. Stored encrypted; WazzOCR does not use it to read mail.</p>
      <div style="display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:.3rem 0 .2rem">
        ${connected ? `<span class="badge success">connected</span><span class="muted" style="font-size:.8rem">Mailbox checked ${esc(ago(s.lastHeartbeatAt))}</span>` : `<span class="badge pending">waiting for the Gmail script</span>`}
        ${outdated ? `<span class="badge failed" title="Running ${esc(s.scriptVersion || 'an old version')}, expected ${esc(s.expectedScriptVersion)}">script out of date</span>` : ''}
      </div>
      ${connected ? usageHtml(s.scriptUsage) : ''}
      <div style="margin-top:.8rem;padding:.8rem .9rem;border:1px solid var(--line);border-radius:9px;background:#FAFBFE;font-size:.84rem">
        <b>Connect the mailbox</b> (once, signed in to that Gmail):
        <ol style="margin:.4rem 0 .6rem 1.1rem;padding:0;line-height:1.6">
          <li>Download the script below — your address and key are already in it.</li>
          <li>Open <a href="https://script.google.com" target="_blank" rel="noopener">script.google.com</a> → New project → paste it → Save.</li>
          <li>Run <b>setup</b>, then <b>installTrigger</b>. The status above turns <i>connected</i> within a minute.</li>
        </ol>
        <a class="btn btn-ghost btn-sm" href="/api/me/email/script">⬇ Download Gmail script</a>
        <span class="muted" style="font-size:.76rem;display:block;margin-top:.4rem">The script contains your account's API key. Keep it private.</span>
      </div>
      <h3>When the Xero org is unclear</h3>
      <p class="muted" style="margin:-.2rem 0 .4rem">WazzOCR asks this WhatsApp number which organisation to use, the same numbered question WhatsApp users get. Reply with the number and the bill is created. Unanswered bills stay in Unmatched.</p>
      <div class="field"><label for="emPhone">WhatsApp number</label><input id="emPhone" inputmode="tel" placeholder="60123456789" value="${esc(s.notifyPhone)}"></div>
      <p class="muted" style="font-size:.76rem;margin:.2rem 0 0">Digits only, international format.${s.hasWhatsAppChannel ? ' If your channel only accepts allowed numbers, add this number under Allowed phone numbers too, or its replies are ignored.' : ' <b>No WhatsApp channel is set up for this account yet, so no message can be sent — bills will wait in Unmatched.</b>'}</p>
      <label style="display:flex;gap:.55rem;align-items:center;margin-top:.8rem;font-size:.88rem;cursor:pointer">
        <input type="checkbox" id="emFailures" ${s.notifyFailures ? 'checked' : ''} style="width:16px;height:16px;padding:0;accent-color:var(--navy)">
        Also WhatsApp this number when an emailed bill fails</label>
      <h3>Google Drive copy</h3>
      <label style="display:flex;gap:.55rem;align-items:flex-start;font-size:.88rem;cursor:pointer">
        <input type="checkbox" id="emDrive" ${s.driveArchive ? 'checked' : ''} style="width:16px;height:16px;padding:0;margin-top:2px;accent-color:var(--navy)">
        <span>Save a copy of every bill to this Gmail's Google Drive<br><span class="muted" style="font-size:.78rem">Email and WhatsApp, including duplicates and ones WazzOCR could not read. Filed under <b>WazzOCR Bills / month / Created, Needs review, Duplicate or Failed</b>.</span></span></label>
      ${driveHtml(s)}
      <div style="display:flex;justify-content:flex-end;margin-top:1rem"><button class="btn btn-primary" id="emSave" type="button">Save</button></div>
      <div class="msg" id="emMsg"></div>`;
    const pw = document.getElementById('emGmailPw');
    document.getElementById('emPwToggle').onclick = (e) => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    };
    const sw = document.getElementById('emEnabled');
    sw.onchange = () => {
      document.getElementById('emSwitch').classList.toggle('is-on', sw.checked);
      const st = document.getElementById('emState'); st.textContent = sw.checked ? 'ON' : 'OFF'; st.classList.toggle('is-on', sw.checked);
    };
    document.getElementById('emSave').onclick = async () => {
      const m = document.getElementById('emMsg');
      try {
        const r = await fetch('/api/me/email/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          enabled: sw.checked,
          gmailAddress: document.getElementById('emGmail').value.trim(),
          gmailPassword: pw.value,
          notifyPhone: document.getElementById('emPhone').value.trim(),
          notifyFailures: document.getElementById('emFailures').checked,
          driveArchive: document.getElementById('emDrive').checked
        }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Save failed.');
        m.className = 'msg ok'; m.textContent = 'Saved.';
        load(true);
      } catch (e) { m.className = 'msg err'; m.textContent = e.message; }
    };
  }

  function init() {
    if (!document.getElementById('ibStyle')) {
      const st = document.createElement('style'); st.id = 'ibStyle'; st.textContent = css; document.head.appendChild(st);
    }
    load();
    wireSettings();
    document.addEventListener('visibilitychange', () => { if (isActive()) load(true); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel) close(); });
  }

  window.EmailInbox = {
    init, load, panelHtml, settingsCardHtml, open, close, resolve, retry, dismiss,
    filter(f) {
      S.filter = f; render();
      const t = document.getElementById('ibFilter'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    clear() { S.filter = 'all'; S.search = ''; render(); }
  };
})();
