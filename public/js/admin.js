let adminData = null;

async function adminFetch(path, options = {}) {
  const token = localStorage.getItem('smartbase_token');
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/v1/admin${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({ success:false, message:'Invalid server response' }));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

async function loadAdmin() {
  const msg = document.getElementById('message');
  msg.textContent = 'Loading administration data…';
  msg.classList.remove('hidden');
  try {
    adminData = await adminFetch('/overview');
    document.getElementById('adminIdentity').textContent = `Administrator: ${adminData.admin.username} • ${adminData.admin.email}`;
    document.getElementById('adminContent').classList.remove('hidden');
    msg.classList.add('hidden');
    renderOverview();
    await loadDatasets();
  } catch (e) {
    document.getElementById('adminContent').classList.add('hidden');
    msg.innerHTML = `<strong>Access unavailable:</strong> ${esc(e.message)}. Log in to the main platform with the administrator account, then open this page again.`;
  }
}

function renderOverview() {
  const users = adminData.users || [];
  document.getElementById('stats').innerHTML = `
    <div class="card"><div class="admin-sub">Registered Users</div><div class="stat-number">${adminData.totals.users}</div></div>
    <div class="card"><div class="admin-sub">Tracked Requests</div><div class="stat-number">${adminData.totals.requests}</div></div>
    <div class="card"><div class="admin-sub">Sessions</div><div class="stat-number">${adminData.totals.sessions}</div></div>
    <div class="card"><div class="admin-sub">Active User Records</div><div class="stat-number">${users.filter(u => u.usage?.last_seen).length}</div></div>`;

  document.getElementById('usersBody').innerHTML = users.map(u => {
    const loc = u.location ? [u.location.city, u.location.region, u.location.country].filter(Boolean).join(', ') : 'Not available';
    return `<tr id="row-${esc(u.id)}">
      <td><input class="user-check" type="checkbox" value="${esc(u.id)}" onchange="markRow(this)"></td>
      <td><strong>${esc(u.username)}</strong><div class="small mono">${esc(u.id)}</div></td>
      <td>${esc(u.email)}</td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleString() : '-'}</td>
      <td>${u.usage?.requests || 0} requests<br>${u.usage?.sessions || 0} sessions</td>
      <td>${u.usage?.last_seen ? new Date(u.usage.last_seen).toLocaleString() : 'No activity tracked'}</td>
      <td>${esc(loc)}<div class="small">Approximate network location</div></td>
      <td>${u.stats?.databases || 0} DB • ${u.stats?.tables || 0} tables • ${u.stats?.records || 0} records</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No accounts</td></tr>';

  const days = Object.entries(adminData.days || {}).sort((a,b)=>b[0].localeCompare(a[0]));
  document.getElementById('daysBody').innerHTML = days.map(([day,d]) => `<tr><td>${esc(day)}</td><td>${d.requests || 0}</td><td>${d.active_users?.length || 0}</td></tr>`).join('') || '<tr><td colspan="3">No usage data yet</td></tr>';
}

function markRow(cb) { document.getElementById(`row-${cb.value}`)?.classList.toggle('user-row-selected', cb.checked); }
function toggleAll(checked) { document.querySelectorAll('.user-check').forEach(cb => { cb.checked = checked; markRow(cb); }); }
function selectedIds() { return [...document.querySelectorAll('.user-check:checked')].map(x=>x.value); }

async function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length) return showToast('Select at least one account.', 'warning');
  if (!(await showConfirm(`Permanently delete ${ids.length} selected account(s) and their stored data?`, { title: 'Delete selected accounts', danger: true, confirmText: 'Delete' }))) return;
  try { await adminFetch('/users', {method:'DELETE', body:JSON.stringify({user_ids:ids})}); await loadAdmin(); }
  catch(e) { showToast(e.message, 'error'); }
}

async function deleteAll() {
  if (!(await showConfirm('Delete ALL non-administrator accounts and their stored Smartbase data? This cannot be undone.', { title: 'Delete all accounts', danger: true, confirmText: 'Continue' }))) return;
  if (!(await showConfirm('Final confirmation: permanently delete every other account?', { title: 'Final confirmation', danger: true, confirmText: 'Delete all' }))) return;
  try { await adminFetch('/users', {method:'DELETE', body:JSON.stringify({all:true})}); await loadAdmin(); }
  catch(e) { showToast(e.message, 'error'); }
}

async function loadDatasets() {
  try {
    const data = await adminFetch('/datasets');
    document.getElementById('datasetsBody').innerHTML = (data.datasets || []).map(d => `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.label)}</td><td>${d.added_at ? new Date(d.added_at).toLocaleString() : '-'}</td><td><button class="btn danger-text" onclick="removeDataset('${esc(d.id)}')">Remove</button></td></tr>`).join('') || '<tr><td colspan="4">No datasets added to the catalog.</td></tr>';
  } catch(e) { document.getElementById('datasetsBody').innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
}

async function addDataset(e) {
  e.preventDefault();
  const dataset_id = document.getElementById('datasetId').value.trim();
  const label = document.getElementById('datasetLabel').value.trim();
  try { await adminFetch('/datasets', {method:'POST', body:JSON.stringify({dataset_id,label})}); document.getElementById('datasetId').value=''; document.getElementById('datasetLabel').value=''; await loadDatasets(); }
  catch(err) { showToast(err.message, 'error'); }
}

async function removeDataset(id) {
  if (!(await showConfirm(`Remove ${id} from the dataset catalog?`, { title: 'Remove dataset', danger: true, confirmText: 'Remove' }))) return;
  try { await adminFetch(`/datasets/${encodeURIComponent(id)}`, {method:'DELETE'}); await loadDatasets(); }
  catch(e) { showToast(e.message, 'error'); }
}

loadAdmin();
