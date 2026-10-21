/* Smartbase admin dashboard. Needs a signed-in administrator (ADMIN_EMAIL); every call is checked on the server. */
const TOKEN = localStorage.getItem('smartbase_token');
let data = null, charts = {}, selected = new Set(), expanded = new Set(), statsCache = {}, probes = {}, editing = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const bytes = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n) || 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 2 : 0) + ' ' + u[i]; };
const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; };
const place = (l) => (l ? [l.city, l.region, l.country].filter(Boolean).join(', ') : '') || '–';
const initial = (u) => esc((u.username || u.email || '?').slice(0, 1).toUpperCase());
const tones = ['bg-blue-600', 'bg-purple-600', 'bg-teal-600', 'bg-pink-600', 'bg-amber-600', 'bg-cyan-600'];
const tone = (s) => tones[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % tones.length];
const dsName = (id) => (id === 'primary' || !id ? 'Primary' : id);

async function api(path, opts = {}) {
  const res = await fetch('/api/v1/admin' + path, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || j.error || 'Request failed (' + res.status + ')'), { status: res.status });
  return j;
}
function message(html, bad) { const m = $('message'); m.classList.remove('hidden'); m.className = 'm-5 card p-4 text-[12px] ' + (bad ? 'text-red-300' : 'text-slate-300'); m.innerHTML = html; $('content').classList.add('hidden'); }

/* ---------- views ---------- */
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + view));
  document.querySelectorAll('.nav a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'dashboard') renderCharts();
}
document.querySelectorAll('.nav a[data-view]').forEach((a) => a.addEventListener('click', () => show(a.dataset.view)));
$('search').addEventListener('input', () => { show('users'); renderUsers(); });

async function loadAll() {
  if (!TOKEN) return message('You are not signed in. <a class="text-[#5b8def] underline" href="/">Sign in to Smartbase</a> with the administrator account, then come back to this page.', true);
  try { data = await api('/overview'); }
  catch (e) {
    if (e.status === 401) return message('Your session expired. <a class="text-[#5b8def] underline" href="/">Sign in again</a>, then reopen this page.', true);
    if (e.status === 403) return message('This account is not the administrator. Sign in with the administrator email.', true);
    return message('Could not load the administration data: ' + esc(e.message) + ' <button class="btn ml-2" onclick="loadAll()">Try again</button>', true);
  }
  $('message').classList.add('hidden'); $('content').classList.remove('hidden');
  $('adminName').textContent = data.admin.username || 'Admin'; $('adminEmail').textContent = data.admin.email || '';
  $('today').textContent = new Date().toLocaleString();
  $('navUsers').textContent = data.totals.users; $('navDatasets').textContent = 1 + data.datasets.datasets.length;
  $('statusText').textContent = 'All systems operational';
  renderStats(); renderCharts(); renderRecent(); renderUsers(); renderActivity(); renderDatasets(); renderSide();
}

function renderStats() {
  const t = data.totals, ds = 1 + data.datasets.datasets.length;
  const card = (bg, icon, label, value, sub) => `<div class="card p-4 bg-gradient-to-br ${bg}"><div class="w-9 h-9 bg-white/10 rounded-lg flex items-center justify-center">${icon}</div><div class="mt-3 text-[11px] text-slate-400">${label}</div><div class="text-[22px] font-bold">${value}</div><div class="text-[10px] text-slate-500 mt-1">${sub}</div></div>`;
  $('stats').innerHTML = card('from-[#11244a]/80 to-[#111832]', '👥', 'Total users', num(t.users), 'Accounts on the platform')
    + card('from-[#0f2e2a]/80 to-[#111832]', '🗄️', 'Total databases', num(t.databases), 'Across all users')
    + card('from-[#2a1747]/80 to-[#111832]', '⚡', 'API requests', num(t.requests), 'Since tracking started')
    + card('from-[#3a2a14]/80 to-[#111832]', '🤗', 'Datasets', ds, `${data.datasets.datasets.filter((d) => d.accepting).length + (data.datasets.primary.accepting ? 1 : 0)} accepting new users`);
}

function renderCharts() {
  if (typeof Chart === 'undefined' || !data) return;
  Object.values(charts).forEach((c) => c.destroy()); charts = {};
  const axis = { x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 9 } } }, y: { beginAtZero: true, grid: { color: '#1a244440' }, ticks: { color: '#6b7280', font: { size: 9 }, precision: 0 } } };
  const lastDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
  const g = lastDays(7);
  charts.g = new Chart($('growthChart'), { type: 'line', data: { labels: g.map((d) => d.slice(5)), datasets: [{ data: g.map((d) => data.signups[d] || 0), borderColor: '#5b8def', backgroundColor: 'rgba(91,141,239,.12)', tension: .35, fill: true, borderWidth: 2, pointRadius: 2 }] }, options: { plugins: { legend: { display: false } }, scales: axis, maintainAspectRatio: false } });
  const r = lastDays(14), byDay = Object.fromEntries(data.days.map((d) => [d.date, d.requests]));
  charts.r = new Chart($('reqChart'), { type: 'bar', data: { labels: r.map((d) => d.slice(5)), datasets: [{ data: r.map((d) => byDay[d] || 0), backgroundColor: '#2a5bff', borderRadius: 4 }] }, options: { plugins: { legend: { display: false } }, scales: axis, maintainAspectRatio: false } });
  const D = data.datasets, items = [{ name: D.primary.label || 'Primary', users: D.primary.users }, ...D.datasets.map((d) => ({ name: d.label || d.id, users: d.users }))];
  const colors = ['#3b82f6', '#22d3ee', '#10b981', '#f59e0b', '#a78bfa', '#f472b6'];
  charts.d = new Chart($('dsChart'), { type: 'doughnut', data: { labels: items.map((i) => i.name), datasets: [{ data: items.map((i) => i.users), backgroundColor: items.map((_, i) => colors[i % colors.length]), borderWidth: 0 }] }, options: { cutout: '70%', plugins: { legend: { display: false } }, maintainAspectRatio: false } });
  $('dsLegend').innerHTML = items.map((i, k) => `<div class="flex items-center gap-2 min-w-0"><span class="w-2 h-2 rounded-full shrink-0" style="background:${colors[k % colors.length]}"></span><span class="truncate">${esc(i.name)}</span><span class="ml-auto">${i.users}</span></div>`).join('');
}

function renderRecent() {
  const rows = [...data.users].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5);
  $('recentUsers').innerHTML = rows.map((u) => `<tr class="border-t border-[#1a2444]"><td class="py-2.5"><div class="flex items-center gap-2"><span class="w-6 h-6 ${tone(u.id)} rounded-full flex items-center justify-center text-[10px]">${initial(u)}</span><div><div>${esc(u.username)}</div><div class="text-[10px] text-slate-500">${esc(u.email)}</div></div></div></td><td>${esc(u.plan || 'free')}</td><td>${u.stats.databases}</td><td class="text-slate-400">${esc((u.created_at || '').slice(0, 10))}<br><span class="text-[10px]">${ago(u.created_at)}</span></td><td><span class="chip mute">${esc(dsName(u.dataset))}</span></td></tr>`).join('') || '<tr><td colspan="5" class="py-3 text-slate-500">No users yet.</td></tr>';
}

function renderUsers() {
  const q = $('search').value.trim().toLowerCase();
  const rows = data.users.filter((u) => !q || [u.username, u.email, u.dataset].some((x) => String(x || '').toLowerCase().includes(q)));
  $('usersSub').textContent = `${rows.length} of ${data.users.length} accounts`;
  $('userRows').innerHTML = rows.map((u) => {
    const st = statsCache[u.id], open = expanded.has(u.id);
    const detail = open ? `<tr class="bg-[#0e1630]"><td></td><td colspan="9" class="py-3 text-[11px] text-slate-300">${st === undefined ? 'Loading…' : st.error ? '<span class="text-red-300">' + esc(st.error) + '</span>' : `Tables <b>${st.tables}</b> · Records <b>${num(st.records)}${st.partial ? '+' : ''}</b> · Files <b>${st.files}</b> (${bytes(st.file_bytes)}) · Dataset <b>${esc(dsName(st.dataset))}</b>${st.partial ? ' · <span class="text-slate-500">large account, record count is a lower bound</span>' : ''}`}</td></tr>` : '';
    return `<tr class="border-t border-[#1a2444] ${selected.has(u.id) ? 'row-sel' : ''}"><td class="py-2.5"><input type="checkbox" data-sel="${esc(u.id)}" ${selected.has(u.id) ? 'checked' : ''} ${u.is_admin ? 'disabled title="The administrator cannot be deleted here"' : ''}></td>
      <td><div class="flex items-center gap-2"><span class="w-6 h-6 ${tone(u.id)} rounded-full flex items-center justify-center text-[10px]">${initial(u)}</span><div><div>${esc(u.username)} ${u.is_admin ? '<span class="chip ok">admin</span>' : ''}</div><div class="text-[10px] text-slate-500">${esc(u.email)}</div></div></div></td>
      <td>${esc(u.plan || 'free')}</td><td><span class="chip mute">${esc(dsName(u.dataset))}</span></td><td>${u.stats.databases}</td><td>${num(u.usage.requests)}</td><td>${num(u.usage.sessions)}</td><td class="text-slate-400">${ago(u.usage.last_seen)}</td><td class="text-slate-400">${esc(place(u.location))}</td>
      <td><button class="btn" data-detail="${esc(u.id)}">${open ? 'Hide' : 'Details'}</button></td></tr>${detail}`;
  }).join('') || '<tr><td colspan="10" class="py-4 text-slate-500">No users match.</td></tr>';
  $('delSel').disabled = !selected.size; $('delSel').textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
}
$('userRows').addEventListener('click', async (e) => {
  const cb = e.target.closest('[data-sel]'); if (cb) { cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel); return renderUsers(); }
  const d = e.target.closest('[data-detail]'); if (!d) return;
  const id = d.dataset.detail;
  if (expanded.has(id)) { expanded.delete(id); return renderUsers(); }
  expanded.add(id); renderUsers();
  if (statsCache[id] === undefined) { try { statsCache[id] = (await api('/users/' + encodeURIComponent(id) + '/stats')).stats; } catch (err) { statsCache[id] = { error: err.message }; } renderUsers(); }
});
function toggleAll(on) { data.users.filter((u) => !u.is_admin).forEach((u) => (on ? selected.add(u.id) : selected.delete(u.id))); renderUsers(); }

function confirmBox(title, body, yes = 'Delete') {
  return new Promise((ok) => { $('dlgTitle').textContent = title; $('dlgBody').textContent = body; $('dlgYes').textContent = yes; $('dlg').classList.remove('hidden');
    const done = (v) => { $('dlg').classList.add('hidden'); $('dlgYes').onclick = $('dlgNo').onclick = null; ok(v); }; $('dlgYes').onclick = () => done(true); $('dlgNo').onclick = () => done(false); });
}
async function deleteSelected() {
  const ids = [...selected]; if (!ids.length) return;
  if (!(await confirmBox('Delete selected users?', `${ids.length} account(s) will be deleted with all their databases, files and records. This cannot be undone.`))) return;
  try { const r = await api('/users', { method: 'DELETE', body: JSON.stringify({ user_ids: ids }) }); selected.clear(); await loadAll(); alert_(`${r.deleted} account(s) deleted.`); } catch (e) { alert_(e.message, true); }
}
async function deleteAll() {
  if (!(await confirmBox('Delete ALL users?', 'Every account except yours will be deleted with all their data. This cannot be undone.', 'Delete everything'))) return;
  try { const r = await api('/users', { method: 'DELETE', body: JSON.stringify({ all: true }) }); selected.clear(); await loadAll(); alert_(`${r.deleted} account(s) deleted.`); } catch (e) { alert_(e.message, true); }
}
function alert_(text, bad) { const m = $('dsMsg'); const box = document.createElement('div'); box.className = 'fixed bottom-4 right-4 card p-3 text-[12px] z-50 ' + (bad ? 'text-red-300' : 'text-emerald-300'); box.textContent = text; document.body.appendChild(box); setTimeout(() => box.remove(), 4500); }

function renderActivity() {
  $('dayRows').innerHTML = data.days.slice(0, 14).map((d) => `<tr class="border-t border-[#1a2444]"><td class="py-2">${esc(d.date)}</td><td>${num(d.requests)}</td><td>${num(d.active_users)}</td></tr>`).join('') || '<tr><td colspan="3" class="py-3 text-slate-500">No activity recorded yet.</td></tr>';
  const eps = {}; data.users.forEach((u) => Object.entries(u.usage.endpoints || {}).forEach(([k, v]) => { eps[k] = (eps[k] || 0) + (typeof v === 'number' ? v : v.count || 0); }));
  $('epRows').innerHTML = Object.entries(eps).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `<tr class="border-t border-[#1a2444]"><td class="py-2 font-mono text-[10px]">${esc(k)}</td><td>${num(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="py-3 text-slate-500">No endpoint data yet.</td></tr>';
}

/* ---------- Hugging Face datasets ---------- */
function dsCard(d, primary) {
  const id = primary ? '_primary' : d.id, p = probes[id], isEdit = editing === id, hasName = d.id && !String(d.id).startsWith('(');
  const usedPct = p && p.used_bytes != null ? Math.min(100, (p.used_bytes / (d.capacity_gb * 1073741824)) * 100) : null;
  return `<div class="card p-4" data-ds="${esc(id)}">
   <div class="flex flex-wrap items-center gap-2 justify-between"><div class="min-w-0"><div class="text-[13px] font-semibold flex items-center gap-2 flex-wrap">${esc(d.label || d.id)} ${primary ? '<span class="chip mute">primary</span>' : ''} <span class="chip ${d.accepting ? 'ok' : 'off'}">${d.accepting ? 'accepting new users' : 'closed to new users'}</span> ${!primary ? `<span class="chip mute">${d.has_token ? 'own token' : 'shared token'}</span>` : ''}</div>
    <div class="text-[11px] text-slate-400 truncate">${hasName ? `<a class="text-[#5b8def]" target="_blank" rel="noopener" href="https://huggingface.co/datasets/${esc(d.id)}">${esc(d.id)}</a>` : esc(d.id)} · ${num(d.users)} account(s) · soft limit ${d.capacity_gb} GB${d.added_at ? ' · added ' + esc(d.added_at.slice(0, 10)) : ''}</div></div>
    <div class="flex flex-wrap gap-2"><button class="btn" data-act="probe">Test connection</button><button class="btn" data-act="toggle">${d.accepting ? 'Stop accepting' : 'Accept new users'}</button><button class="btn" data-act="edit">${isEdit ? 'Close' : 'Edit'}</button>${primary ? '' : `<button class="btn btn-danger" data-act="remove" ${d.users ? 'disabled title="Accounts still use this dataset"' : ''}>Remove</button>`}</div></div>
   ${p ? `<div class="mt-3 text-[11px] ${p.ok ? 'text-emerald-300' : 'text-red-300'}">${p.ok ? `✓ Read and write work (${p.ms} ms)` : '✗ ' + esc(p.error || 'Test failed')}${p.used_bytes != null ? ` · uses ${bytes(p.used_bytes)}` : p.hf_error ? ` · usage unavailable (${esc(p.hf_error)})` : ''}</div>${usedPct != null ? `<div class="h-1.5 bg-[#1a2444] rounded-full mt-2"><div class="h-1.5 rounded-full ${usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}" style="width:${Math.max(usedPct, 1)}%"></div></div>` : ''}` : ''}
   ${isEdit ? `<div class="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 items-end"><label class="text-[10px] text-slate-400">Label<input data-f="label" class="w-full mt-1" value="${esc(d.label || '')}"></label><label class="text-[10px] text-slate-400">Soft limit (GB)<input data-f="cap" type="number" min="1" class="w-full mt-1" value="${d.capacity_gb}"></label>${primary ? '' : '<label class="text-[10px] text-slate-400">Replace token (optional)<input data-f="token" type="password" autocomplete="off" class="w-full mt-1" placeholder="hf_…"></label>'}<button class="btn btn-primary" data-act="save">Save</button></div>` : ''}
  </div>`;
}
function renderDatasets() {
  const D = data.datasets;
  $('dsList').innerHTML = dsCard(D.primary, true) + D.datasets.map((d) => dsCard(d, false)).join('')
    + `<div class="text-[10px] text-slate-500">Existing accounts keep their data where it is. Accounts, API keys and admin data always stay on the primary dataset.</div>`;
}
$('dsList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const card = b.closest('[data-ds]'), id = card.dataset.ds, enc = encodeURIComponent(id);
  const D = data.datasets, d = id === '_primary' ? D.primary : D.datasets.find((x) => x.id === id);
  try {
    if (b.dataset.act === 'probe') { b.disabled = true; b.textContent = 'Testing…'; probes[id] = await api('/datasets/' + enc + '/probe', { method: 'POST' }); renderDatasets(); }
    else if (b.dataset.act === 'toggle') { data.datasets = await api('/datasets/' + enc, { method: 'PATCH', body: JSON.stringify({ accepting: !d.accepting }) }); renderAfterDatasets(); }
    else if (b.dataset.act === 'edit') { editing = editing === id ? null : id; renderDatasets(); }
    else if (b.dataset.act === 'save') {
      const body = { label: card.querySelector('[data-f=label]').value, capacity_gb: card.querySelector('[data-f=cap]').value }; const t = card.querySelector('[data-f=token]'); if (t && t.value) body.token = t.value;
      data.datasets = await api('/datasets/' + enc, { method: 'PATCH', body: JSON.stringify(body) }); editing = null; renderAfterDatasets(); alert_('Saved.');
    } else if (b.dataset.act === 'remove') {
      if (!(await confirmBox('Remove this dataset?', `${d.id} will no longer be used for new accounts. Nothing is deleted on Hugging Face.`, 'Remove'))) return;
      data.datasets = await api('/datasets/' + enc, { method: 'DELETE' }); renderAfterDatasets();
    }
  } catch (err) { alert_(err.message, true); renderDatasets(); }
});
function renderAfterDatasets() { $('navDatasets').textContent = 1 + data.datasets.datasets.length; renderDatasets(); renderStats(); renderCharts(); renderSide(); }
$('addDs').addEventListener('submit', async (e) => {
  e.preventDefault(); const btn = $('dsAddBtn'), msg = $('dsMsg'); btn.disabled = true; btn.textContent = 'Testing…'; msg.className = 'text-[11px] mt-3 text-slate-300'; msg.textContent = 'Testing a write to the dataset…';
  try {
    const body = { dataset_id: $('dsId').value, label: $('dsLabel').value, capacity_gb: $('dsCap').value, accepting: $('dsAccept').checked }; if ($('dsToken').value) body.token = $('dsToken').value;
    const r = await api('/datasets', { method: 'POST', body: JSON.stringify(body) });
    data.datasets = r; $('addDs').reset(); $('dsCap').value = 100; msg.className = 'text-[11px] mt-3 text-emerald-300'; msg.textContent = `✓ Added. Read and write work (${r.probe.ms} ms).`; renderAfterDatasets();
  } catch (err) { msg.className = 'text-[11px] mt-3 text-red-300'; msg.textContent = err.message; }
  btn.disabled = false; btn.textContent = 'Test & add';
});

function renderSide() {
  const feed = [...data.users].filter((u) => u.usage.last_seen).sort((a, b) => String(b.usage.last_seen).localeCompare(String(a.usage.last_seen))).slice(0, 4).map((u) => ({ t: u.usage.last_seen, i: '👤', a: 'User active', b: `${esc(u.username)} · ${ago(u.usage.last_seen)}` }))
    .concat([...data.users].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 3).map((u) => ({ t: u.created_at, i: '✨', a: 'New account', b: `${esc(u.username)} joined ${ago(u.created_at)}` })));
  $('recentAct').innerHTML = feed.map((f) => `<div class="flex gap-3"><div class="w-7 h-7 bg-blue-500/20 rounded-full flex items-center justify-center text-[12px]">${f.i}</div><div><div class="text-[11px] font-medium">${f.a}</div><div class="text-[10px] text-slate-500">${f.b}</div></div></div>`).join('') || '<div class="text-[11px] text-slate-500">Nothing yet.</div>';
  const D = data.datasets, accepting = (D.primary.accepting ? 1 : 0) + D.datasets.filter((d) => d.accepting).length, n = [];
  if (!accepting) n.push(['off', '⚠️', 'No dataset accepts new users', 'New sign-ups will fail to store data. Turn one on in Hugging Face Datasets.']);
  if (!D.datasets.length) n.push(['mute', 'ℹ️', 'Only one dataset', 'Add another dataset before the primary one fills up.']);
  if (D.datasets.some((d) => d.users && !d.accepting)) n.push(['mute', 'ℹ️', 'Some datasets are closed', 'Their accounts keep working; only new accounts go elsewhere.']);
  if (!n.length) n.push(['ok', '✅', 'Everything looks good', `${accepting} dataset(s) accepting new users.`]);
  const colr = { ok: 'bg-emerald-500/10 border-emerald-500/20', off: 'bg-red-500/10 border-red-500/20', mute: 'bg-blue-500/10 border-blue-500/20' };
  $('notes').innerHTML = n.map((x) => `<div class="flex gap-2 ${colr[x[0]]} border rounded-lg p-2.5"><span>${x[1]}</span><div><div class="text-[11px] font-medium">${esc(x[2])}</div><div class="text-[10px] text-slate-400">${esc(x[3])}</div></div></div>`).join('');
}

window.loadAll = loadAll; window.show = show; window.toggleAll = toggleAll; window.deleteSelected = deleteSelected; window.deleteAll = deleteAll;
loadAll();
