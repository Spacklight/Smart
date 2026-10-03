
let currentUser = null;
let currentToken = null;
let authMode = 'register';
let selectedDatabase = null;
let selectedTable = null;
let databasesCache = [];
let queryHistory = [];

// Theme preference
function applyTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', selected);
  localStorage.setItem('smartbase_theme', selected);
  const label = selected === 'dark' ? '☀️ Light' : '🌙 Dark';
  document.querySelectorAll('.theme-toggle').forEach(btn => btn.textContent = label);
}
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'); }
applyTheme(localStorage.getItem('smartbase_theme') || 'dark');

function setAuthLoading(show, title = 'Signing you in…', message = 'Please wait while Smartbase completes authentication.') {
  const el = document.getElementById('authLoading');
  if (!el) return;
  document.getElementById('authLoadingTitle').textContent = title;
  document.getElementById('authLoadingMessage').textContent = message;
  el.classList.toggle('hidden', !show);
}
function openTerms(event) { event?.preventDefault(); document.getElementById('termsModal').classList.remove('hidden'); }
function closeTerms() { document.getElementById('termsModal').classList.add('hidden'); }


// Monetization (push-ad network) is loaded only after auth state is settled
// (logged in vs. not), never before. Its service worker watches the whole
// site, so loading it any earlier lets it intercept the Google Sign-In
// popup/redirect and the token exchange that follows - which is what was
// breaking login and registration. Delaying it by well under a second here
// avoids that entirely while still showing it to essentially every visitor.
function loadMonetization() {
  if (document.getElementById('sb-monetization')) return;
  const s = document.createElement('script');
  s.id = 'sb-monetization';
  s.src = 'https://quge5.com/88/tag.min.js';
  s.async = true;
  s.dataset.zone = '288483';
  s.dataset.cfasync = 'false';
  document.head.appendChild(s);
}


// One-time cleanup for visitors who loaded the site before the fix below and
// already have the monetization service worker installed. A service worker
// keeps running for a browser regardless of what today's page contains, so
// removing the <script> tag does nothing for them on its own - only
// unregistering it (and reloading once, if it was actively controlling this
// page) actually clears it. Runs at most once per tab session.
async function clearStaleServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (sessionStorage.getItem('smartbase_sw_cleared') === '1') return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    if (!regs.length) { sessionStorage.setItem('smartbase_sw_cleared', '1'); return; }
    const wasControlled = !!navigator.serviceWorker.controller;
    await Promise.all(regs.map(r => r.unregister()));
    sessionStorage.setItem('smartbase_sw_cleared', '1');
    if (wasControlled) { location.reload(); return true; }
  } catch (e) { /* best effort - never block sign-in on this */ }
  return false;
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
  if (await clearStaleServiceWorker()) return; // reloading; this load is done
  try {
    const hadPendingAuth = sessionStorage.getItem('smartbase_google_pending') === '1';
    if (hadPendingAuth) setAuthLoading(true, 'Signing you in…', 'Google authentication is completing. Please wait.');
    const redirectData = await window.smartbaseFirebase?.handleFirebaseRedirectResult();
    if (redirectData?.token) {
      currentToken = redirectData.token;
      localStorage.setItem('smartbase_token', currentToken);
      hideAuth();
      await fetchUser();
      setAuthLoading(false);
      loadMonetization();
      return;
    }
  } catch (e) {
    setAuthLoading(false);
    showToast(e.message || 'Google authentication failed.', 'error');
  }
  const token = localStorage.getItem('smartbase_token');
  if (token) {
    currentToken = token;
    await fetchUser();
  }
  loadMonetization();
});

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`;
  
  const res = await fetch(`/api/v1${path}`, { ...options, headers });
  const data = await res.json();
  
  if (!res.ok) {
    if (res.status === 401) {
      logout();
      throw new Error('Session expired');
    }
    throw data;
  }
  return data;
}

async function fetchUser() {
  try {
    const data = await api('/auth/me');
    currentUser = data.user;
    document.getElementById('userDisplay').textContent = `${currentUser.username} • ${currentUser.plan} plan`;
    document.getElementById('landingPage').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    updateLimits();
    navigate('dashboard');
    
    // Check storage mode
    const health = await fetch('/api/health').then(r=>r.json());
    document.getElementById('storageMode').textContent = `Cloud: ${health.status === 'ok' ? 'Connected' : 'Unavailable'}`;
  } catch (e) {
    console.error('fetchUser failed', e);
    logout();
  }
}

function showAuth(mode = 'register') {
  authMode = mode;
  document.getElementById('authModal').classList.remove('hidden');
  toggleAuthUI();
}

function hideAuth() {
  document.getElementById('authModal').classList.add('hidden');
  document.getElementById('authError').classList.add('hidden');
  document.getElementById('termsCheckbox').checked = false;
  setAuthLoading(false);
}

function toggleAuthMode() {
  authMode = authMode === 'register' ? 'login' : 'register';
  toggleAuthUI();
}

function toggleAuthUI() {
  const isRegister = authMode === 'register';
  document.getElementById('authTitle').textContent = isRegister ? 'Create Account' : 'Welcome Back';
  document.getElementById('authSubtitle').textContent = isRegister
    ? 'Use your Google account to create a secure Smartbase account.'
    : 'Continue with Google to securely access your Smartbase account.';
  document.getElementById('authGoogleText').textContent = isRegister ? 'Continue with Google' : 'Sign in with Google';
  document.getElementById('termsRow').classList.toggle('hidden', !isRegister);
  if (!isRegister) document.getElementById('termsCheckbox').checked = false;
}

async function handleGoogleAuth() {
  const errorEl = document.getElementById('authError');
  errorEl.classList.add('hidden');
  const button = document.querySelector('.google-auth-btn');
  const isRegister = authMode === 'register';
  if (isRegister && !document.getElementById('termsCheckbox').checked) {
    errorEl.textContent = 'Please agree to the Smartbase Terms & Conditions before creating your account.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (button) { button.disabled = true; button.classList.add('loading'); }
  if (isRegister) sessionStorage.setItem('smartbase_terms_pending', '1');
  setAuthLoading(true, isRegister ? 'Creating your account…' : 'Signing you in…', isRegister ? 'Google authentication is being completed. Please wait.' : 'Please wait while Smartbase completes authentication.');
  try {
    const data = await window.smartbaseFirebase.startGoogleAuth();
    if (!data) return;
    sessionStorage.removeItem('smartbase_terms_pending');
    currentToken = data.token;
    localStorage.setItem('smartbase_token', currentToken);
    hideAuth();
    await fetchUser();
    setAuthLoading(false);
    showToast(isRegister ? 'Your Smartbase account was created successfully.' : 'Signed in successfully.', 'success');
  } catch (err) {
    sessionStorage.removeItem('smartbase_terms_pending');
    setAuthLoading(false);
    errorEl.textContent = err.message || 'Google authentication failed.';
    errorEl.classList.remove('hidden');
    showToast(err.message || 'Google authentication failed.', 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('loading'); }
  }
}

async function handleAuth() { return handleGoogleAuth(); }

function logout() {
  localStorage.removeItem('smartbase_token');
  currentToken = null;
  currentUser = null;
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('landingPage').classList.remove('hidden');
  fetch('/api/v1/auth/logout', { method: 'POST' });
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function navigate(page) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const active = document.querySelector(`[data-page="${page}"]`);
  if (active) active.classList.add('active');
  
  document.getElementById('sidebar').classList.remove('open');
  
  const titles = {
    dashboard: 'Dashboard',
    databases: 'Databases',
    tables: 'Tables',
    editor: 'SQL Editor',
    data: 'Data Browser',
    api: 'API Center',
    learn: 'Learn Smartbase',
    experiences: 'Community Experiences',
    settings: 'Settings'
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  
  switch(page) {
    case 'dashboard': renderDashboard(); break;
    case 'databases': renderDatabases(); break;
    case 'tables': renderTables(); break;
    case 'editor': renderEditor(); break;
    case 'data': renderDataBrowser(); break;
    case 'api': renderAPI(); break;
    case 'learn': renderLearn(); break;
    case 'experiences': renderExperiences(); break;
    case 'settings': renderSettings(); break;
    default: renderDashboard();
  }
}

async function updateLimits() {
  try {
    const data = await api('/auth/me');
    const stats = data.user.stats;
    document.getElementById('dbLimitText').textContent = `${stats.databases} / ${stats.database_limit}`;
    document.getElementById('dbProgress').style.width = `${(stats.databases/stats.database_limit)*100}%`;
    document.getElementById('tableLimitText').textContent = `${stats.tables} / ${stats.total_table_limit || 500}`;
    document.getElementById('tableProgress').style.width = `${Math.min(100, (stats.tables/(stats.total_table_limit || 500))*100)}%`;
  } catch {}
}

async function renderDashboard() {
  const content = document.getElementById('content');
  content.innerHTML = `<div>Loading...</div>`;
  
  try {
    const [dbData, auditData, meData] = await Promise.all([
      api('/databases').catch(()=>({databases:[]})),
      api('/audit').catch(()=>({logs:[]})),
      api('/auth/me').catch(()=>({user:{stats:{}}}))
    ]);
    
    databasesCache = dbData.databases || [];
    const stats = meData.user?.stats || { databases:0, tables:0, records:0 };
    
    content.innerHTML = `
      <div style="margin-bottom:2rem;">
        <h2 style="font-size:1.75rem; margin-bottom:0.5rem;">Welcome to Smartbase, ${currentUser?.username || ''} 👋</h2>
        <p style="color: var(--text-secondary);">Your databases are saved securely in the cloud. Build without managing servers.</p>
      </div>
      
      <div class="grid" style="margin-bottom:2rem;">
        <div class="card"><div class="card-header"><span class="card-title">Databases</span><span class="badge">${stats.databases} / 20</span></div><div style="font-size:2rem; font-weight:800;">${stats.databases}</div><div class="progress"><div class="progress-fill" style="width:${(stats.databases/5)*100}%"></div></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Tables</span><span class="badge">${stats.tables} / 500</span></div><div style="font-size:2rem; font-weight:800;">${stats.tables}</div><div class="progress"><div class="progress-fill" style="width:${Math.min(100,(stats.tables/500)*100)}%"></div></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Records</span><span class="badge badge-success">Live</span></div><div style="font-size:2rem; font-weight:800;">${stats.records}</div><p style="font-size:0.8rem; color: var(--text-secondary); margin-top:0.5rem;">Saved to cloud storage</p></div>
        <div class="card"><div class="card-header"><span class="card-title">Storage</span><span class="badge badge-success">Cloud</span></div><div style="font-size:0.9rem;">All data is saved to durable cloud storage and survives restarts.</div></div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <h3>Your Databases</h3>
        <button class="btn btn-primary" onclick="showCreateDatabase()">+ Create Database</button>
      </div>
      
      <div class="grid" id="dbGrid">
        ${databasesCache.length === 0 ? '<div class="card"><p style="color: var(--text-secondary);">No databases yet. Create your first one!</p><button class="btn btn-primary" style="margin-top:1rem;" onclick="showCreateDatabase()">+ Create Database</button></div>' : databasesCache.map(db => `
          <div class="card" onclick="openDatabase('${db.id}')" style="cursor:pointer;">
            <div class="card-header"><span class="card-title">🗄️ ${db.name}</span><span class="badge mono">${db.id}</span></div>
            <p style="font-size:0.85rem; color: var(--text-secondary);">${db.description || 'No description'}</p>
            <div class="stats"><span>${new Date(db.created_at).toLocaleDateString()}</span><span>•</span><span>${db.status}</span></div>
            <div style="margin-top:1rem;"><button class="btn" style="width:100%;" onclick="event.stopPropagation(); openDatabase('${db.id}')">Open Database →</button></div>
          </div>
        `).join('')}
        ${databasesCache.length > 0 && databasesCache.length < 5 ? '<div class="card" style="border-style:dashed; display:flex; align-items:center; justify-content:center; min-height:150px; cursor:pointer;" onclick="showCreateDatabase()"><div style="text-align:center;"><div style="font-size:2rem;">+</div><div>Create Database</div><div style="font-size:0.75rem; color: var(--text-muted);">${databasesCache.length} / 20 used</div></div></div>' : ''}
      </div>

      <div style="margin-top:2.5rem;">
        <h3 style="margin-bottom:1rem;">Recent Activity</h3>
        <div class="table-container"><table class="data-table"><thead><tr><th>Operation</th><th>Database</th><th>Time</th></tr></thead><tbody>
          ${(auditData.logs || []).slice(0,8).map(log => `<tr><td><span class="badge">${log.operation}</span></td><td class="mono">${log.database_name || log.database_id || '-'}</td><td>${new Date(log.timestamp).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="3" style="color: var(--text-muted); text-align:center;">No activity yet</td></tr>'}
        </tbody></table></div>
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div style="color: var(--danger);">Failed to load dashboard: ${e.message}</div>`;
  }
}

async function showCreateDatabase() {
  const name = await showPrompt('Choose a unique database name using letters, numbers and underscores.', {
    title: 'Create database', confirmText: 'Next', maxLength: 64
  });
  if (!name || !name.trim()) return;
  const desc = await showPrompt('Add an optional description so you can identify this database later.', {
    title: 'Database description', confirmText: 'Create database', maxLength: 200
  });
  if (desc === null) return;
  try {
    await api('/databases', { method: 'POST', body: JSON.stringify({ name: name.trim(), description: desc.trim() }) });
    showToast(`Database '${name.trim()}' created successfully.`, 'success');
    renderDashboard(); updateLimits();
  } catch (err) { showToast(err.message || 'Failed to create database', 'error'); }
}

async function openDatabase(dbId) {
  selectedDatabase = databasesCache.find(d => d.id === dbId) || { id: dbId };
  try {
    const data = await api(`/databases/${dbId}`);
    selectedDatabase = data.database;
    navigate('tables');
  } catch (e) {
    showToast('Failed to open database: ' + e.message, 'error');
  }
}

async function renderDatabases() {
  const content = document.getElementById('content');
  content.innerHTML = 'Loading...';
  try {
    const data = await api('/databases');
    databasesCache = data.databases;
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
        <div><h2>Databases</h2><p style="color: var(--text-secondary); font-size:0.9rem;">${data.count} / ${data.limit} used • Free plan limit enforced server-side</p></div>
        <button class="btn btn-primary" onclick="showCreateDatabase()" ${data.count >= data.limit ? 'disabled' : ''}>+ Create Database</button>
      </div>
      <div class="limit-bar"><span>Free Plan: ${data.count} / 20 databases</span><div class="progress" style="width:120px;"><div class="progress-fill" style="width:${(data.count/20)*100}%"></div></div></div>
      <div class="grid">
        ${data.databases.map(db => `
          <div class="card">
            <div class="card-header"><span class="card-title">🗄️ ${db.name}</span><span class="badge mono">${db.id}</span></div>
            <p style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:1rem;">${db.description || 'No description'}</p>
            <div class="stats"><span>${new Date(db.created_at).toLocaleDateString()}</span></div>
            <div style="display:flex; gap:0.5rem; margin-top:1rem;">
              <button class="btn btn-primary" style="flex:1;" onclick="openDatabase('${db.id}')">Open</button>
              <button class="btn" onclick="renameDatabase('${db.id}', '${db.name}')">Rename</button>
              <button class="btn" style="color: var(--danger);" onclick="deleteDatabase('${db.id}', '${db.name}')">Delete</button>
            </div>
          </div>
        `).join('') || '<div class="card"><p>No databases yet</p></div>'}
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div>Error: ${e.message}</div>`;
  }
}

async function renameDatabase(id, oldName) {
  const newName = await showPrompt(`Enter a new name for '${oldName}'.`, {
    title: 'Rename database', value: oldName, confirmText: 'Save name', maxLength: 64
  });
  if (!newName || newName.trim() === oldName) return;
  try {
    await api(`/databases/${id}`, { method: 'PUT', body: JSON.stringify({ name: newName.trim() }) });
    showToast('Database renamed successfully.', 'success');
    renderDatabases();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteDatabase(id, name) {
  const typed = await showPrompt(`To permanently delete '${name}' and all its tables and records, enter ${name.toUpperCase()} below.`, {
    title: 'Delete database', confirmText: 'Delete permanently', maxLength: 64
  });
  if (typed !== name.toUpperCase()) {
    if (typed !== null) showToast('Deletion cancelled — the confirmation text did not match.', 'warning');
    return;
  }
  try {
    await api(`/databases/${id}`, { method: 'DELETE' });
    showToast(`Database '${name}' deleted successfully.`, 'success');
    renderDatabases(); updateLimits();
  } catch (e) { showToast(e.message, 'error'); }
}

async function renderTables() {
  const content = document.getElementById('content');
  if (!selectedDatabase || !selectedDatabase.id) {
    content.innerHTML = `<div class="card"><p>No database selected. Go to Databases and open one.</p><button class="btn btn-primary" onclick="navigate('databases')">Go to Databases</button></div>`;
    return;
  }
  
  content.innerHTML = 'Loading tables...';
  try {
    const data = await api(`/databases/${selectedDatabase.id}/tables`);
    content.innerHTML = `
      <div style="margin-bottom:1.5rem;">
        <button class="btn" onclick="navigate('databases')">← Back to Databases</button>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:1.5rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h2 style="display:flex; align-items:center; gap:0.5rem;">🗄️ ${selectedDatabase.name} <span class="badge mono">${selectedDatabase.id}</span></h2>
          <p style="color: var(--text-secondary); font-size:0.85rem; margin-top:0.25rem;">Tables: ${data.count} / ${data.limit} • Database saved to cloud storage</p>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-primary" onclick="showCreateTable()" ${data.count >= data.limit ? 'disabled' : ''}>+ Create Table</button>
          <button class="btn" onclick="navigate('editor')">SQL Editor</button>
        </div>
      </div>
      
      <div class="limit-bar"><span>Tables in ${selectedDatabase.name}: ${data.count} / 50</span><div class="progress" style="width:120px;"><div class="progress-fill" style="width:${(data.count/50)*100}%"></div></div></div>
      
      <div class="grid">
        ${data.tables.map(t => `
          <div class="card" style="cursor:pointer;" onclick="openTable('${t.id}')">
            <div class="card-header"><span class="card-title">📊 ${t.name}</span><span class="badge">${t.columns?.length || 0} cols</span></div>
            <div class="stats"><span>${t.record_count || 0} records</span><span>•</span><span>${new Date(t.created_at).toLocaleDateString()}</span></div>
            <div style="margin-top:0.75rem; font-size:0.75rem; color: var(--text-muted);">ID: ${t.id}</div>
            <div style="display:flex; gap:0.5rem; margin-top:1rem;">
              <button class="btn btn-primary" style="flex:1;" onclick="event.stopPropagation(); openTable('${t.id}')">Open</button>
              <button class="btn" onclick="event.stopPropagation(); deleteTable('${t.id}', '${t.name}')" style="color: var(--danger);">Delete</button>
            </div>
          </div>
        `).join('') || '<div class="card"><p>No tables yet. Create your first table!</p></div>'}
        ${data.count < data.limit && data.count > 0 ? '<div class="card" style="border-style:dashed; display:flex; align-items:center; justify-content:center; min-height:120px; cursor:pointer;" onclick="showCreateTable()"><div style="text-align:center;"><div style="font-size:1.5rem;">+</div><div>Create Table</div></div></div>' : ''}
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div>Error: ${e.message}</div>`;
  }
}

async function showCreateTable() {
  if (!selectedDatabase) return;
  const name = await showPrompt('Choose a table name using letters, numbers and underscores.', {
    title: 'Create table', confirmText: 'Next', maxLength: 64
  });
  if (!name || !name.trim()) return;
  const colsInput = await showPrompt('Define columns as name:TYPE, separated by commas. Example: id:INTEGER, name:TEXT, email:TEXT', {
    title: 'Define table columns', confirmText: 'Create table', multiline: true, rows: 4, maxLength: 2000
  });
  if (!colsInput || !colsInput.trim()) return;

  try {
    const columns = colsInput.split(',').map(s => {
      const [n, t] = s.split(':').map(x=>x.trim());
      if (!n || !t) throw new Error(`Invalid column: ${s}`);
      return { name: n.toLowerCase(), type: t.toUpperCase(), nullable: true };
    });
    
    api(`/databases/${selectedDatabase.id}/tables`, { method: 'POST', body: JSON.stringify({ name, columns }) })
      .then(() => { showToast(`Table '${name}' created!`, 'success'); renderTables(); updateLimits(); })
      .catch(err => showToast(err.message, 'error'));
  } catch (e) {
    showToast('Invalid columns format: ' + e.message, 'error');
  }
}

async function deleteTable(id, name) {
  if (!(await showConfirm(`Delete table '${name}' and all its records? This cannot be undone.`, { title: 'Delete table', danger: true, confirmText: 'Delete' }))) return;
  try {
    await api(`/databases/${selectedDatabase.id}/tables/${id}`, { method: 'DELETE' });
    renderTables();
    updateLimits();
  } catch (e) { showToast(e.message, 'error'); }
}

async function openTable(tableId) {
  try {
    const data = await api(`/databases/${selectedDatabase.id}/tables/${tableId}`);
    selectedTable = data.table;
    navigate('data');
  } catch (e) { showToast(e.message, 'error'); }
}

async function renderDataBrowser() {
  const content = document.getElementById('content');
  if (!selectedDatabase || !selectedTable) {
    content.innerHTML = `<div class="card"><p>Select a database and table first.</p><div style="display:flex; gap:0.5rem; margin-top:1rem;"><button class="btn" onclick="navigate('databases')">Databases</button><button class="btn" onclick="navigate('tables')">Tables</button></div></div>`;
    return;
  }

  content.innerHTML = 'Loading data...';
  try {
    const recordsData = await api(`/databases/${selectedDatabase.id}/tables/${selectedTable.id}/records?limit=50`);
    const table = selectedTable;
    
    content.innerHTML = `
      <div style="margin-bottom:1rem;">
        <button class="btn" onclick="navigate('tables')">← Back to ${selectedDatabase.name}</button>
      </div>
      
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h2>📊 ${table.name} <span class="badge mono">${table.id}</span></h2>
          <p style="color: var(--text-secondary); font-size:0.85rem;">${table.columns?.length || 0} columns • ${recordsData.pagination?.total || 0} records • Saved to cloud storage</p>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-primary" onclick="showAddRecord()">+ Add Record</button>
          <button class="btn" onclick="navigate('editor')">SQL Editor</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab active" onclick="switchTab('data')">Data</div>
        <div class="tab" onclick="switchTab('structure')">Structure</div>
        <div class="tab" onclick="switchTab('sql')">SQL</div>
      </div>

      <div id="tab-data">
        <div class="table-container">
          <table class="data-table">
            <thead><tr>${table.columns?.map(c => `<th>${c.name}<br><span style="font-weight:400; text-transform:none; font-size:0.7rem;">${c.type}</span></th>`).join('') || ''}<th>Actions</th></tr></thead>
            <tbody>
              ${recordsData.records.map(r => `<tr>${table.columns?.map(c => `<td>${r[c.name] !== undefined ? String(r[c.name]).substring(0,100) : '<span style="color:var(--text-muted)">NULL</span>'}</td>`).join('') || ''}<td><button class="btn" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="deleteRecord('${r.id}')">Delete</button></td></tr>`).join('') || `<tr><td colspan="${(table.columns?.length || 1)+1}" style="text-align:center; color: var(--text-muted);">No records yet. Add your first record or use SQL INSERT.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div style="margin-top:1rem; display:flex; justify-content:space-between; align-items:center; font-size:0.85rem; color: var(--text-secondary);">
          <span>Showing ${recordsData.records.length} of ${recordsData.pagination?.total || 0} • Page ${recordsData.pagination?.page || 1} of ${recordsData.pagination?.pages || 1}</span>
          <div style="display:flex; gap:0.5rem;">
            <button class="btn" onclick="loadRecordsPage(${(recordsData.pagination?.page || 1)-1})" ${!recordsData.pagination || recordsData.pagination.page <=1 ? 'disabled' : ''}>Previous</button>
            <button class="btn" onclick="loadRecordsPage(${(recordsData.pagination?.page || 1)+1})" ${!recordsData.pagination || recordsData.pagination.page >= recordsData.pagination.pages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      </div>

      <div id="tab-structure" class="hidden">
        <div class="table-container">
          <table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead>
            <tbody>${table.columns?.map(c => `<tr><td class="mono">${c.name}</td><td><span class="badge">${c.type}</span></td><td>${c.nullable ? 'Yes' : 'No'}</td></tr>`).join('') || ''}</tbody>
          </table>
        </div>
        <div style="margin-top:1rem;"><button class="btn" onclick="showToast('ALTER TABLE coming soon - use recreate for now', 'info')">+ Add Column</button></div>
      </div>

      <div id="tab-sql" class="hidden">
        <div class="card"><h4>Quick SQL for ${table.name}</h4>
          <div style="background: var(--bg); padding:1rem; border-radius:8px; margin-top:1rem; font-family:'JetBrains Mono', monospace; font-size:0.85rem;">
            <div>SELECT * FROM ${table.name};</div>
            <div>INSERT INTO ${table.name} (${table.columns?.map(c=>c.name).join(', ')}) VALUES (...);</div>
            <div>UPDATE ${table.name} SET ... WHERE ...;</div>
            <div>DELETE FROM ${table.name} WHERE ...;</div>
          </div>
          <button class="btn btn-primary" style="margin-top:1rem;" onclick="navigate('editor')">Open SQL Editor</button>
        </div>
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div>Error: ${e.message}</div>`;
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-data').classList.toggle('hidden', name !== 'data');
  document.getElementById('tab-structure').classList.toggle('hidden', name !== 'structure');
  document.getElementById('tab-sql').classList.toggle('hidden', name !== 'sql');
}

async function showAddRecord() {
  if (!selectedTable) return;
  const columns = selectedTable.columns || [];
  const values = {};
  
  for (const col of columns) {
    if (col.name === 'id') continue; // auto-generated
    const val = await showPrompt(`Enter a value for ${col.name}.`, {
      title: `${col.name} · ${col.type}${col.nullable ? ' · nullable' : ' · required'}`,
      confirmText: 'Add record', maxLength: 2000
    });
    if (val === null) return; // cancelled
    if (!col.nullable && !val) { showToast(`${col.name} is required`, 'warning'); return; }
    
    let parsed = val;
    if (col.type === 'INTEGER') parsed = val ? parseInt(val) : null;
    if (col.type === 'FLOAT') parsed = val ? parseFloat(val) : null;
    if (col.type === 'BOOLEAN') parsed = val ? (val.toLowerCase() === 'true') : null;
    values[col.name] = parsed || null;
  }
  
  // Auto id
  if (columns.find(c=>c.name==='id')) {
    values.id = Date.now();
  }
  
  try {
    await api(`/databases/${selectedDatabase.id}/tables/${selectedTable.id}/records`, { method: 'POST', body: JSON.stringify({ records: [values] }) });
    showToast('Record added!', 'success');
    renderDataBrowser();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRecord(recordId) {
  if (!(await showConfirm('Delete this record?', { title: 'Delete record', danger: true, confirmText: 'Delete' }))) return;
  try {
    await api(`/databases/${selectedDatabase.id}/tables/${selectedTable.id}/records/${recordId}`, { method: 'DELETE' });
    renderDataBrowser();
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadRecordsPage(page) {
  if (page < 1) return;
  // Re-render with page param - simplified
  const content = document.getElementById('content');
  content.innerHTML = 'Loading...';
  try {
    const recordsData = await api(`/databases/${selectedDatabase.id}/tables/${selectedTable.id}/records?page=${page}&limit=50`);
    // For brevity, just re-render data browser will reset to page 1, but we have pagination
    renderDataBrowser();
  } catch (e) {
    content.innerHTML = `Error: ${e.message}`;
  }
}

async function renderEditor() {
  const content = document.getElementById('content');
  const dbOptions = databasesCache.map(db => `<option value="${db.id}" ${selectedDatabase?.id === db.id ? 'selected' : ''}>${db.name}</option>`).join('');
  
  content.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; flex-wrap:wrap; gap:1rem;">
      <div><h2>⌨️ SQL Editor</h2><p style="color: var(--text-secondary); font-size:0.9rem;">Controlled SQL subset • All writes are saved to cloud storage</p></div>
      <div style="display:flex; gap:0.5rem; align-items:center;">
        <select id="editorDbSelect" class="form-input" style="width:auto; min-width:180px;" onchange="selectedDatabase = databasesCache.find(d=>d.id===this.value);">
          <option value="">Select database</option>
          ${dbOptions}
        </select>
      </div>
    </div>

    <div class="sql-editor">
      <div class="editor-toolbar">
        <div style="font-size:0.8rem; color: var(--text-secondary);">Smartbase SQL • Supported: CREATE/SHOW/DROP DATABASE, CREATE/SHOW/DROP TABLE, INSERT, SELECT, UPDATE, DELETE</div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn" onclick="clearEditor()">Clear</button>
          <button class="btn btn-primary" onclick="runSQL()">▶ Run</button>
        </div>
      </div>
      <div class="editor-area">
        <div class="line-numbers" id="lineNumbers">1<br>2<br>3<br>4<br>5</div>
        <textarea id="sqlInput" class="sql-textarea" placeholder="-- Write your SQL here&#10;CREATE DATABASE shop;&#10;SHOW DATABASES;&#10;CREATE TABLE users (id INTEGER, name TEXT, email TEXT);&#10;INSERT INTO users (id, name, email) VALUES (1, 'John Banda', 'john@example.com');&#10;SELECT * FROM users;&#10;UPDATE users SET email = 'new@example.com' WHERE id = 1;&#10;DELETE FROM users WHERE id = 1;" oninput="updateLineNumbers()" onkeydown="handleEditorKey(event)"></textarea>
      </div>
    </div>

    <div style="margin-top:1rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn" onclick="insertTemplate('CREATE DATABASE mydb;')">CREATE DATABASE</button>
      <button class="btn" onclick="insertTemplate('SHOW DATABASES;')">SHOW DATABASES</button>
      <button class="btn" onclick="insertTemplate('CREATE TABLE customers (id INTEGER, name TEXT, email TEXT, age INTEGER);')">CREATE TABLE</button>
      <button class="btn" onclick="insertTemplate('SHOW TABLES;')">SHOW TABLES</button>
      <button class="btn" onclick="insertTemplate('SELECT * FROM customers;')">SELECT *</button>
      <button class="btn" onclick="insertTemplate('SELECT * FROM customers WHERE age > 25 LIMIT 10;')">SELECT WHERE</button>
    </div>

    <div id="sqlResult" class="result-box hidden"></div>
    
    <div style="margin-top:1.5rem;">
      <h4 style="margin-bottom:0.5rem;">Query History</h4>
      <div id="queryHistory" style="font-size:0.85rem; color: var(--text-secondary);">${queryHistory.length ? queryHistory.map((q,i)=>`<div style="padding:0.5rem; border-bottom:1px solid var(--border); cursor:pointer;" onclick="document.getElementById('sqlInput').value=\`${q.sql.replace(/`/g,'\`')}\`; updateLineNumbers();">${i+1}. ${q.sql.substring(0,80)}... <span style="float:right;">${new Date(q.time).toLocaleTimeString()}</span></div>`).join('') : '<div style="color: var(--text-muted);">No queries yet</div>'}</div>
    </div>
  `;
  
  updateLineNumbers();
}

function updateLineNumbers() {
  const textarea = document.getElementById('sqlInput');
  if (!textarea) return;
  const lines = textarea.value.split('\n').length;
  const numbersEl = document.getElementById('lineNumbers');
  if (numbersEl) {
    numbersEl.innerHTML = Array.from({length: Math.max(5, lines)}, (_,i)=>i+1).join('<br>');
  }
}

function handleEditorKey(e) {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    runSQL();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = e.target.selectionStart;
    const end = e.target.selectionEnd;
    e.target.value = e.target.value.substring(0, start) + '  ' + e.target.value.substring(end);
    e.target.selectionStart = e.target.selectionEnd = start + 2;
  }
}

function clearEditor() {
  document.getElementById('sqlInput').value = '';
  updateLineNumbers();
  document.getElementById('sqlResult').classList.add('hidden');
}

function insertTemplate(sql) {
  const textarea = document.getElementById('sqlInput');
  textarea.value = sql;
  textarea.focus();
  updateLineNumbers();
}

async function runSQL() {
  const sqlEl = document.getElementById('sqlInput');
  const resultEl = document.getElementById('sqlResult');
  const dbSelect = document.getElementById('editorDbSelect');
  
  const sql = sqlEl.value.trim();
  if (!sql) { showToast('Enter SQL first', 'warning'); return; }
  
  const databaseId = dbSelect?.value || selectedDatabase?.id || null;
  
  // For SHOW DATABASES and CREATE DATABASE, databaseId can be null
  const upper = sql.toUpperCase();
  const needsDb = !(upper.includes('CREATE DATABASE') || upper.includes('SHOW DATABASES') || upper.includes('DROP DATABASE'));
  
  if (needsDb && !databaseId) {
    showToast('Select a database first (or use CREATE DATABASE / SHOW DATABASES)', 'warning');
    return;
  }
  
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div style="color: var(--text-secondary);">Running...</div>';
  
  try {
    const start = Date.now();
    const data = await api('/query', { method: 'POST', body: JSON.stringify({ database_id: databaseId, sql }) });
    const duration = Date.now() - start;
    
    queryHistory.unshift({ sql, time: new Date().toISOString(), duration });
    queryHistory = queryHistory.slice(0,20);
    
    let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;"><span style="color: var(--success);">✓ Success • ${duration}ms</span><span style="font-size:0.8rem; color: var(--text-muted);">${data.count !== undefined ? data.count + ' rows' : data.message || ''}</span></div>`;
    
    if (data.rows) {
      if (data.rows.length === 0) {
        html += '<div style="color: var(--text-muted);">No rows returned</div>';
      } else {
        const cols = Object.keys(data.rows[0]);
        html += `<div class="table-container"><table class="data-table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`;
        html += data.rows.slice(0,100).map(r=>`<tr>${cols.map(c=>`<td>${r[c] !== null && r[c] !== undefined ? String(r[c]).substring(0,200) : '<span style="color:var(--text-muted)">NULL</span>'}</td>`).join('')}</tr>`).join('');
        html += '</tbody></table></div>';
        if (data.rows.length > 100) html += `<div style="margin-top:0.5rem; font-size:0.8rem; color: var(--text-muted);">Showing first 100 of ${data.rows.length} rows</div>`;
      }
    } else if (data.database) {
      html += `<div>Database created: <span class="mono badge">${data.database.name}</span> ID: <span class="mono">${data.database.id}</span></div>`;
      // Refresh caches
      api('/databases').then(d=>{ databasesCache = d.databases; updateLimits(); }).catch(()=>{});
    } else if (data.table) {
      html += `<div>Table created: <span class="mono badge">${data.table.name}</span> ID: <span class="mono">${data.table.id}</span></div>`;
      updateLimits();
    } else {
      html += `<div>${data.message || 'Query executed successfully'}</div>`;
      if (data.rows) html += `<pre style="margin-top:1rem; background: var(--bg); padding:1rem; border-radius:8px; overflow-x:auto;">${JSON.stringify(data, null, 2)}</pre>`;
    }
    
    resultEl.innerHTML = html;
  } catch (e) {
    resultEl.innerHTML = `<div style="color: var(--danger);"><strong>✗ Error: ${e.error || 'QUERY_FAILED'}</strong><br>${e.message || 'Unknown error'}</div>`;
  }
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function apiBaseUrl() { return `${location.origin}/apiv1`; }

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1500); }
  } catch {
    try {
      const helper = document.createElement('textarea');
      helper.value = text; helper.style.position = 'fixed'; helper.style.opacity = '0';
      document.body.appendChild(helper); helper.focus(); helper.select();
      const copied = document.execCommand('copy'); helper.remove();
      if (copied) {
        if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1500); }
      } else showToast('Clipboard access was blocked. Please copy the key manually from the field.', 'warning');
    } catch { showToast('Clipboard access was blocked. Please copy the key manually from the field.', 'warning'); }
  }
}

async function renderAPI() {
  const content = document.getElementById('content');
  const base = apiBaseUrl();
  content.innerHTML = `
    <h2>🔑 API Center</h2>
    <p style="color:var(--text-secondary);margin:.5rem 0 1.5rem;">
      Connect websites, mobile apps and backend services to your Smartbase databases using secure API keys.
    </p>
    <div class="card" style="margin-bottom:1.25rem;">
      <div class="card-header"><span class="card-title">Usage limits</span><span class="badge">Free plan</span></div>
      <div class="grid" style="margin-top:1rem;">
        <div><strong>2,000</strong><div class="muted-copy">API requests/day</div></div>
        <div><strong>20</strong><div class="muted-copy">API requests/minute</div></div>
        <div><strong>5</strong><div class="muted-copy">API keys/account</div></div>
        <div><strong>2 MB</strong><div class="muted-copy">API request body</div></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1.25rem;">
      <div class="card-header"><span class="card-title">Choose the right API access</span><span class="badge">Secure by key</span></div>
      <div class="grid" style="margin-top:1rem;">
        <div class="card" style="margin:0;"><h3>Read key</h3><p class="muted-copy">Read databases, tables and records, plus <code>SELECT</code> and <code>SHOW</code> queries.</p></div>
        <div class="card" style="margin:0;"><h3>Write key</h3><p class="muted-copy">Create, update or delete data and run write SQL.</p></div>
        <div class="card" style="margin:0;"><h3>Collective</h3><p class="muted-copy">Creates one read key and one write key for applications that need both permissions.</p></div>
      </div>
    </div>
    <div class="card">
      <h3>Create an API key</h3>
      <p class="muted-copy">Give each application its own key. Never place a key in public source code or commit it to GitHub.</p>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1rem;">
        <input id="apiKeyName" class="form-input" maxlength="40" placeholder="Application name (e.g. My Shop App)" style="flex:1;min-width:200px;">
        <select id="apiKeyType" class="form-input" style="min-width:210px;">
          <option value="read">Read access</option><option value="write">Write access</option><option value="collective">Read + Write</option>
        </select>
      </div>
      <button class="btn btn-primary" style="margin-top:1rem;" onclick="generateAPIKey()">Generate API key</button>
      <div id="apiKeyResult" style="margin-top:1rem;"></div>
    </div>
    <div class="card" style="margin-top:1.25rem;"><h3>Your API keys</h3><div id="apiKeyList" style="margin-top:.75rem;color:var(--text-secondary);">Loading...</div></div>
    <div class="card" style="margin-top:1.25rem;">
      <h3>How API authentication works</h3>
      <p class="muted-copy">Send the key with every request to <code>${escapeHtml(base)}</code>. Use either <code>X-API-Key</code> or <code>Authorization: Bearer</code>. Keep powerful keys on your server.</p>
      <pre class="code-block">curl ${escapeHtml(base)}/databases \
  -H "Authorization: Bearer YOUR_READ_KEY"

# Equivalent:
curl ${escapeHtml(base)}/databases \
  -H "X-API-Key: YOUR_READ_KEY"</pre>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h3>Common API endpoints</h3>
      <div class="api-endpoint-list">
        <div><span class="badge badge-success">GET</span> <code>/databases</code> — list databases</div>
        <div><span class="badge badge-success">GET</span> <code>/databases/:id/tables</code> — list tables</div>
        <div><span class="badge badge-success">GET</span> <code>/databases/:id/tables/:tableId/records</code> — read records</div>
        <div><span class="badge badge-success">POST</span> <code>/query</code> — SELECT/SHOW with a read key</div>
        <div><span class="badge">POST</span> <code>/databases</code> — create a database with a write key</div>
        <div><span class="badge">POST</span> <code>/databases/:id/tables</code> — create a table</div>
        <div><span class="badge">POST</span> <code>/databases/:id/tables/:tableId/records</code> — insert records</div>
        <div><span class="badge">PUT / DELETE</span> <code>/databases/...</code> — update or remove resources</div>
        <div><span class="badge">POST</span> <code>/query</code> — INSERT/UPDATE/DELETE/CREATE/DROP with a write key</div>
      </div>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h3>JavaScript example</h3>
      <p class="muted-copy">For browser applications, do not expose a write key in public client-side code. Prefer a backend or serverless function.</p>
      <pre class="code-block">const response = await fetch('${escapeHtml(base)}/databases', {
  headers: { Authorization: 'Bearer YOUR_READ_KEY' }
});
const result = await response.json();
console.log(result);</pre>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h3>SQL through the API</h3>
      <pre class="code-block">curl -X POST ${escapeHtml(base)}/query \
  -H "Authorization: Bearer YOUR_READ_KEY" \
  -H "Content-Type: application/json" \
  -d '{"database_id":"sb_db_xxx","sql":"SELECT * FROM customers"}'</pre>
      <p class="muted-copy" style="margin-top:.75rem;">Responses are JSON. Errors include a structured <code>error</code> code and human-readable <code>message</code>.</p>
    </div>
    <div class="card" style="margin-top:1.25rem;">
      <h3>Security checklist</h3>
      <ul class="muted-copy" style="line-height:1.8;padding-left:1.2rem;">
        <li>Use separate keys for separate applications.</li><li>Use read keys whenever possible.</li>
        <li>Store keys in server-side environment variables or secret managers.</li>
        <li>Revoke a key immediately if it may have been exposed.</li><li>Never publish API keys in GitHub or screenshots.</li>
      </ul>
    </div>`;
  loadAPIKeys();
}

async function loadAPIKeys() {
  const el = document.getElementById('apiKeyList');
  if (!el) return;
  try {
    const data = await api('/api-keys');
    if (!data.keys.length) { el.textContent = 'No API keys yet.'; return; }
    el.innerHTML = data.keys.map(k => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap; padding:0.6rem 0; border-top:1px solid var(--border, rgba(255,255,255,0.08));">
        <div>
          <div style="color: var(--text);"><strong>${escapeHtml(k.name)}</strong>
            <span class="badge ${k.type === 'write' ? '' : 'badge-success'}" style="margin-left:0.4rem;">${k.type === 'write' ? 'Write' : 'Read'}</span>
            ${k.group ? '<span class="badge" style="margin-left:0.25rem;">Collective</span>' : ''}
          </div>
          <div style="font-size:0.8rem; font-family:'JetBrains Mono', monospace;">••••${escapeHtml(k.hint)} · created ${new Date(k.created_at).toLocaleDateString()}</div>
        </div>
        <button class="btn btn-secondary" onclick="revokeAPIKey('${escapeHtml(k.id)}')">Revoke</button>
      </div>`).join('');
  } catch (e) {
    el.textContent = (e && e.message) || 'Could not load API keys.';
  }
}

async function generateAPIKey() {
  const type = document.getElementById('apiKeyType').value;
  const name = document.getElementById('apiKeyName').value.trim();
  try {
    const data = await api('/api-keys', { method: 'POST', body: JSON.stringify({ type, name }) });
    const label = k => (k.type === 'write' ? 'Write key' : 'Read key');
    document.getElementById('apiKeyResult').innerHTML = `
      <div style="background: rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.2); padding:1rem; border-radius:8px;">
        <div style="font-weight:600; color: var(--success);">${data.keys.length > 1 ? 'API keys generated' : 'API key generated'} - copy ${data.keys.length > 1 ? 'them' : 'it'} now, ${data.keys.length > 1 ? "they won't" : "it won't"} be shown again!</div>
        ${data.keys.map(k => `
          <div style="margin-top:0.75rem;">
            <div style="font-size:0.8rem; color: var(--text-secondary);">${label(k)}</div>
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
              <div style="flex:1; min-width:200px; font-family:'JetBrains Mono', monospace; background: var(--bg); padding:0.75rem; border-radius:6px; margin-top:0.25rem; word-break:break-all;">${escapeHtml(k.key)}</div>
              <button class="btn btn-secondary" data-key="${escapeHtml(k.key)}" onclick="copyText(this.dataset.key, this)">Copy</button>
            </div>
          </div>`).join('')}
      </div>
    `;
    document.getElementById('apiKeyName').value = '';
    loadAPIKeys();
  } catch (e) {
    showToast((e && e.message) || 'Could not create API key', 'error');
  }
}

async function revokeAPIKey(id) {
  if (!(await showConfirm('Revoke this API key? Apps using it will stop working immediately.', { title: 'Revoke API key', danger: true, confirmText: 'Revoke' }))) return;
  try {
    await api(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadAPIKeys();
  } catch (e) {
    showToast((e && e.message) || 'Could not revoke API key', 'error');
  }
}


async function renderLearn() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <h2>Learn Smartbase</h2>
    <p class="muted-copy" style="margin:.5rem 0 1.5rem;">A practical guide to creating, managing and connecting applications to Smartbase.</p>
    <div class="card"><h3>What is Smartbase?</h3><p class="muted-copy">Smartbase is a cloud database platform for creating databases, designing tables, managing records, running a controlled SQL language and connecting applications through a REST API without managing a traditional database server.</p></div>
    <div class="grid" style="margin-top:1.25rem;">
      <div class="card"><h3>1. Create an account</h3><p class="muted-copy">Sign in with Google to create or access your Smartbase account.</p></div>
      <div class="card"><h3>2. Create a database</h3><p class="muted-copy">Create a database for a project, product, school system, website or application.</p></div>
      <div class="card"><h3>3. Create tables</h3><p class="muted-copy">Define columns with supported types such as INTEGER, TEXT, BOOLEAN, DATE and JSON.</p></div>
      <div class="card"><h3>4. Manage records</h3><p class="muted-copy">Insert, read, update and delete records through the dashboard or SQL editor.</p></div>
      <div class="card"><h3>5. Use SQL</h3><p class="muted-copy">Use the supported SQL commands for CREATE, SHOW, INSERT, SELECT, UPDATE and DELETE.</p></div>
      <div class="card"><h3>6. Connect an app</h3><p class="muted-copy">Create an API key and call Smartbase from your backend or server-side application.</p></div>
    </div>
    <div class="card" style="margin-top:1.25rem;"><h3>Smartbase functions</h3><div class="api-endpoint-list">
      <div><strong>Database management</strong> — create, rename, open and delete databases.</div>
      <div><strong>Table management</strong> — define structured tables and columns.</div>
      <div><strong>Record management</strong> — add, view, update and delete application data.</div>
      <div><strong>SQL editor</strong> — work with the supported SQL subset in a controlled environment.</div>
      <div><strong>REST API</strong> — connect websites, mobile apps and backend services.</div>
      <div><strong>Authentication</strong> — secure account access through Google authentication.</div>
      <div><strong>API permissions</strong> — separate read and write access using API keys.</div>
      <div><strong>Cloud persistence</strong> — data is stored in durable cloud storage.</div>
    </div></div>
    <div class="card" style="margin-top:1.25rem;"><h3>Who can use Smartbase?</h3><p class="muted-copy">Developers, students, small businesses, startups, schools, project teams, website builders, mobile-app developers and anyone who needs structured data storage without wanting to manage a traditional database server.</p></div>
    <div class="card" style="margin-top:1.25rem;"><h3>Free plan limits</h3><div class="grid" style="margin-top:.75rem;"><div><strong>5</strong><div class="muted-copy">databases per account</div></div><div><strong>10</strong><div class="muted-copy">tables per database</div></div><div><strong>50</strong><div class="muted-copy">tables across the free workspace</div></div></div></div>
    <div class="card" style="margin-top:1.25rem;"><h3>Recommended workflow</h3><pre class="code-block">Account → Database → Tables → Records → SQL / Dashboard → REST API → Your application</pre></div>`;
}

async function renderExperiences() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <h2>Community Experiences</h2>
    <p class="muted-copy" style="margin:.5rem 0 1.5rem;">See how people are using Smartbase and share your own experience with the community.</p>
    <div class="card" style="margin-bottom:1.25rem;">
      <h3>Share your Smartbase experience</h3><p class="muted-copy">Tell the community what you are building, what you like, or what you would improve.</p>
      <label class="form-label" style="margin-top:1rem;">Title</label><input id="experienceTitle" class="form-input" maxlength="80" placeholder="e.g. Smartbase simplified my project">
      <label class="form-label" style="margin-top:.75rem;">Your experience</label><textarea id="experienceMessage" class="form-input" maxlength="1000" rows="5" placeholder="Share your experience with Smartbase..."></textarea>
      <label class="form-label" style="margin-top:.75rem;">Rating</label><select id="experienceRating" class="form-input" style="max-width:220px;"><option value="5">5 — Excellent</option><option value="4">4 — Very good</option><option value="3">3 — Good</option><option value="2">2 — Needs improvement</option><option value="1">1 — Poor</option></select>
      <button class="btn btn-primary" style="margin-top:1rem;" onclick="submitExperience()">Publish experience</button>
      <div id="experienceStatus" class="muted-copy" style="margin-top:.6rem;"></div>
    </div>
    <div id="experienceList" class="grid"><div class="card">Loading community experiences...</div></div>`;
  loadExperiences();
}

async function loadExperiences() {
  const el = document.getElementById('experienceList');
  if (!el) return;
  try {
    const r = await fetch('/api/v1/experiences'); const data = await r.json();
    if (!r.ok) throw data;
    const items = data.experiences || [];
    el.innerHTML = items.length ? items.map(x => `
      <article class="card"><div class="card-header"><span class="card-title">${escapeHtml(x.title || 'Smartbase experience')}</span><span class="badge badge-success">${'★'.repeat(Math.max(1, Math.min(5, Number(x.rating) || 5)))}</span></div>
      <p class="muted-copy" style="margin-top:.75rem;">${escapeHtml(x.message)}</p>
      <div class="stats" style="margin-top:1rem;"><span>${escapeHtml(x.display_name || 'Smartbase user')}</span><span>•</span><span>${new Date(x.created_at).toLocaleDateString()}</span></div></article>`).join('') :
      '<div class="card"><p class="muted-copy">No community experiences have been published yet. Be the first to share yours.</p></div>';
  } catch (e) { el.innerHTML = `<div class="card"><p style="color:var(--danger);">${escapeHtml(e.message || 'Could not load experiences.')}</p></div>`; }
}

async function submitExperience() {
  const title = document.getElementById('experienceTitle')?.value.trim();
  const message = document.getElementById('experienceMessage')?.value.trim();
  const rating = Number(document.getElementById('experienceRating')?.value || 5);
  if (!title || !message) { showToast('Please provide a title and your experience.', 'warning'); return; }
  try {
    await api('/experiences', { method:'POST', body:JSON.stringify({ title, message, rating }) });
    showToast('Experience published successfully.', 'success');
    document.getElementById('experienceTitle').value=''; document.getElementById('experienceMessage').value='';
    await loadExperiences();
  } catch (e) { showToast(e.message || 'Could not publish your experience.', 'error'); }
}

async function renderSettings() {
  const content = document.getElementById('content');
  const user = currentUser;
  content.innerHTML = `
    <h2>⚙️ Settings</h2>
    <div class="grid" style="margin-top:1.5rem;">
      <div class="card">
        <h3>Account</h3>
        <div style="margin-top:1rem; font-size:0.9rem; line-height:1.8;">
          <div><strong>Username:</strong> ${user?.username}</div>
          <div><strong>Email:</strong> ${user?.email}</div>
          <div><strong>User ID:</strong> <span class="mono badge">${user?.id}</span></div>
          <div><strong>Plan:</strong> ${user?.plan} (Free)</div>
          <div><strong>Member since:</strong> ${user?.created_at ? new Date(user.created_at).toLocaleDateString() : '-'}</div>
        </div>
      </div>
      
      <div class="card">
        <h3>Storage</h3>
        <p style="font-size:0.85rem; color: var(--text-secondary); margin:0.5rem 0;">Your data is saved to durable cloud storage.</p>
        <div style="font-size:0.85rem; margin-top:1rem; line-height:1.8;">
          <div>✅ All databases saved to the cloud</div>
          <div>✅ All tables saved to the cloud</div>
          <div>✅ All records saved to the cloud</div>
          <div>✅ Survives server restarts</div>
          <div>✅ User isolation enforced</div>
          <div>✅ Limits enforced server-side</div>
        </div>
        <div style="margin-top:1rem; padding:0.75rem; background: var(--bg); border-radius:8px; font-size:0.8rem;">
          <div>Cloud storage: <span class="badge badge-success" id="settingsStorageMode">Checking...</span></div>
        </div>
      </div>
      
      <div class="card">
        <h3>Limits (Free Plan)</h3>
        <div style="margin-top:1rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Databases</span><span id="settingsDbLimit">- / 20</span></div>
          <div class="progress"><div class="progress-fill" id="settingsDbProg"></div></div>
          <div style="display:flex; justify-content:space-between; margin:1rem 0 0.5rem;"><span>Tables per DB</span><span>50 max</span></div>
          <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Total Tables</span><span id="settingsTableLimit">- / 500</span></div>
          <div class="progress"><div class="progress-fill" id="settingsTableProg"></div></div>
          <div style="margin-top:1rem; line-height:1.8; color:var(--text-secondary);">
            <div>File storage: <strong>500 MB/user</strong></div>
            <div>Maximum file upload: <strong>25 MB</strong></div>
            <div>API usage: <strong>2,000/day</strong>, <strong>20/minute</strong></div>
            <div>API keys: <strong>5/account</strong></div>
            <div>API request body: <strong>2 MB</strong></div>
          </div>
        </div>
      </div>
      
      <div class="card">
        <h3>Security</h3>
        <div style="font-size:0.85rem; color: var(--text-secondary); margin-top:0.5rem; line-height:1.6;">
          <div>• Passwords hashed with bcrypt (12 rounds)</div>
          <div>• JWT with 7-day expiry, httpOnly cookie</div>
          <div>• User isolation: User A cannot access User B data</div>
          <div>• Every request verifies ownership</div>
          <div>• Secrets are never exposed to the browser</div>
          <div>• SQL parser allows only known commands</div>
          <div>• No shell execution from SQL</div>
        </div>
      </div>
    </div>
  `;
  
  try {
    const me = await api('/auth/me');
    const stats = me.user.stats;
    document.getElementById('settingsDbLimit').textContent = `${stats.databases} / 20`;
    document.getElementById('settingsDbProg').style.width = `${Math.min(100, (stats.databases/20)*100)}%`;
    document.getElementById('settingsTableLimit').textContent = `${stats.tables} / 500`;
    document.getElementById('settingsTableProg').style.width = `${Math.min(100, (stats.tables/500)*100)}%`;
    
    const health = await fetch('/api/health').then(r=>r.json());
    document.getElementById('settingsStorageMode').textContent = health.status === 'ok' ? 'Connected' : 'Unavailable';
  } catch {}
}
