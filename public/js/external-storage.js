
(function(){
  "use strict";

  if(window.__SMARTBASE_STORAGE_UI__) return;
  window.__SMARTBASE_STORAGE_UI__ = true;

  const PROVIDERS = [["backblaze-b2","Backblaze B2"]];

  const api = async (url, options={}) => {
    const response = await fetch(url,{
      credentials:"include",
      headers:{
        "Content-Type":"application/json",
        ...(options.headers||{})
      },
      ...options
    });

    let data={};
    try{ data=await response.json(); }catch(_){}

    if(!response.ok){
      throw new Error(data.message || data.error || ("Request failed ("+response.status+")"));
    }
    return data;
  };

  const esc = value => String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

  function launcher(){
    const b=document.createElement("button");
    b.id="smartbase-storage-launcher";
    b.textContent="☁ External Storage";
    b.onclick=openPanel;
    document.body.appendChild(b);
  }

  function openPanel(){
    if(document.getElementById("smartbase-storage-overlay")) return;

    const overlay=document.createElement("div");
    overlay.id="smartbase-storage-overlay";

    overlay.innerHTML=`
      <div id="smartbase-storage-panel">
        <div class="smartbase-storage-head">
          <div>
            <h2>☁ External Storage</h2>
            <div class="smartbase-storage-muted">
              Connect your Backblaze B2 bucket to Smartbase.
            </div>
          </div>
          <button class="smartbase-storage-close" id="sb-storage-close">×</button>
        </div>

        <div class="smartbase-storage-tabs">
          <button class="smartbase-storage-tab active" data-tab="connections">Connections</button>
          <button class="smartbase-storage-tab" data-tab="add">Add Storage</button>
          <button class="smartbase-storage-tab" data-tab="database">Database Binding</button>
          <button class="smartbase-storage-tab" data-tab="files">File Storage</button>
        </div>

        <div id="sb-storage-content"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById("sb-storage-close").onclick=()=>overlay.remove();

    overlay.addEventListener("click",e=>{
      if(e.target===overlay) overlay.remove();
    });

    overlay.querySelectorAll(".smartbase-storage-tab").forEach(tab=>{
      tab.onclick=()=>{
        overlay.querySelectorAll(".smartbase-storage-tab")
          .forEach(x=>x.classList.remove("active"));
        tab.classList.add("active");
        render(tab.dataset.tab);
      };
    });

    render("connections");
  }

  async function render(tab){
    const box=document.getElementById("sb-storage-content");
    if(!box)return;

    if(tab==="connections") return renderConnections(box);
    if(tab==="add") return renderAdd(box);
    if(tab==="database") return renderDatabase(box);
    if(tab==="files") return renderFilesTab(box);
  }

  async function renderConnections(box){
    box.innerHTML=`<div class="smartbase-storage-card">Loading storage connections...</div>`;

    try{
      const data=await api("/api/v1/storage/connections");
      const connections=data.connections||[];

      if(!connections.length){
        box.innerHTML=`
          <div class="smartbase-storage-empty">
            <div style="font-size:35px">☁</div>
            <h3>No external storage connected</h3>
            <p>Add your Backblaze B2 bucket to use external object storage.</p>
            <button class="smartbase-storage-btn smartbase-storage-primary" id="sb-add-first">
              + Add Storage
            </button>
          </div>`;
        document.getElementById("sb-add-first").onclick=()=>{
          document.querySelector('[data-tab="add"]').click();
        };
        return;
      }

      box.innerHTML=connections.map(c=>`
        <div class="smartbase-storage-card">
          <h3>${esc(c.name)}</h3>
          <div class="smartbase-storage-muted">
            ${esc(providerName(c.provider))} · Bucket: ${esc(c.bucket)}
          </div>
          <div class="smartbase-storage-muted" style="margin-top:5px">
            ${esc(c.endpoint)}
          </div>
          <div class="smartbase-storage-actions">
            <button class="smartbase-storage-btn smartbase-storage-secondary"
                    data-test="${esc(c.id)}">Test Connection</button>
            <button class="smartbase-storage-btn smartbase-storage-danger"
                    data-delete="${esc(c.id)}">Delete</button>
          </div>
        </div>
      `).join("");

      box.querySelectorAll("[data-test]").forEach(btn=>{
        btn.onclick=async()=>{
          btn.disabled=true;
          btn.textContent="Testing...";
          try{
            const r=await api("/api/v1/storage/connections/"+encodeURIComponent(btn.dataset.test)+"/test",{method:"POST"});
            alert(r.message || "Storage connection successful.");
          }catch(e){ alert(e.message); }
          finally{
            btn.disabled=false;
            btn.textContent="Test Connection";
          }
        };
      });

      box.querySelectorAll("[data-delete]").forEach(btn=>{
        btn.onclick=async()=>{
          if(!confirm("Delete this storage connection?"))return;
          try{
            await api("/api/v1/storage/connections/"+encodeURIComponent(btn.dataset.delete),{
              method:"DELETE"
            });
            renderConnections(box);
          }catch(e){ alert(e.message); }
        };
      });

    }catch(e){
      box.innerHTML=`<div class="smartbase-storage-error">${esc(e.message)}</div>`;
    }
  }

  function renderAdd(box){
    box.innerHTML=`
      <form id="sb-storage-form">
        <div class="smartbase-storage-grid">
          <div class="smartbase-storage-field">
            <label>Connection name</label>
            <input name="name" required placeholder="My Backblaze B2">
          </div>

          <div class="smartbase-storage-field">
            <label>Provider</label>
            <select name="provider" id="sb-provider">
              ${PROVIDERS.map(p=>`<option value="${p[0]}">${p[1]}</option>`).join("")}
            </select>
          </div>

          <div class="smartbase-storage-field">
            <label>Endpoint</label>
            <input name="endpoint" required placeholder="https://...">
          </div>

          <div class="smartbase-storage-field">
            <label>Region</label>
            <input name="region" placeholder="us-east-005">
          </div>

          <div class="smartbase-storage-field">
            <label>Bucket</label>
            <input name="bucket" required placeholder="my-bucket">
          </div>

          <div class="smartbase-storage-field">
            <label>Access Key ID</label>
            <input name="accessKeyId" class="smartbase-storage-secret" required>
          </div>

          <div class="smartbase-storage-field">
            <label>Secret Access Key</label>
            <input name="secretAccessKey" class="smartbase-storage-secret" type="password" required>
          </div>

          <div class="smartbase-storage-field">
            <label>Path Style</label>
            <select name="forcePathStyle">
              <option value="false">Automatic</option>
              <option value="true">Force path style</option>
            </select>
          </div>
        </div>

        <div class="smartbase-storage-muted" style="margin:8px 0 15px">
          Credentials are sent to Smartbase over HTTPS and are stored encrypted on the server.
        </div>

        <div id="sb-add-message"></div>

        <div class="smartbase-storage-actions">
          <button class="smartbase-storage-btn smartbase-storage-primary" type="submit">
            Connect Storage
          </button>
        </div>
      </form>
    `;

    document.getElementById("sb-storage-form").onsubmit=async e=>{
      e.preventDefault();

      const form=e.target;
      const fd=new FormData(form);
      const payload=Object.fromEntries(fd.entries());
      payload.forcePathStyle=payload.forcePathStyle==="true";

      const message=document.getElementById("sb-add-message");
      message.innerHTML=`<div class="smartbase-storage-card">Connecting...</div>`;

      try{
        await api("/api/v1/storage/connections",{
          method:"POST",
          body:JSON.stringify(payload)
        });

        message.innerHTML=`
          <div class="smartbase-storage-success">
            Storage connection created successfully.
          </div>`;

        form.reset();
      }catch(err){
        message.innerHTML=`<div class="smartbase-storage-error">${esc(err.message)}</div>`;
      }
    };
  }

  const when = t => t ? new Date(t).toLocaleString() : "never";
  const kb = n => n > 1048576 ? (n/1048576).toFixed(2)+" MB" : (n/1024).toFixed(1)+" KB";
  const say = (el, cls, text) => { el.innerHTML = `<div class="smartbase-storage-${cls}">${esc(text)}</div>`; };
  const busy = (btn, text, fn) => async () => { const old = btn.textContent; btn.disabled = true; btn.textContent = text; try { await fn(); } finally { btn.disabled = false; btn.textContent = old; } };

  async function renderDatabase(box){
    box.innerHTML=`
      <div class="smartbase-storage-card">
        <h3>Bind a database to your external storage</h3>
        <div class="smartbase-storage-muted">Choose one of your databases and one of your storage connections. After binding you can test the connection and back the database up into your own bucket.</div>
        <div class="smartbase-storage-field" style="margin-top:15px"><label>Database</label><select id="sb-db-id"></select></div>
        <div class="smartbase-storage-field"><label>Storage connection</label><select id="sb-db-connection"></select></div>
        <div id="sb-db-message"></div>
        <div class="smartbase-storage-actions"><button class="smartbase-storage-btn smartbase-storage-primary" id="sb-bind-db">Bind database</button></div>
        <div id="sb-db-result" style="margin-top:15px"></div>
      </div>`;
    const dbSel=document.getElementById("sb-db-id"), connSel=document.getElementById("sb-db-connection"), message=document.getElementById("sb-db-message"), result=document.getElementById("sb-db-result");
    try{
      const [dbs, conns] = await Promise.all([api("/api/v1/databases"), api("/api/v1/storage/connections")]);
      const list = dbs.databases || [], connections = conns.connections || [];
      dbSel.innerHTML = list.length ? list.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("") : `<option value="">You have no databases yet</option>`;
      connSel.innerHTML = connections.length ? connections.map(c=>`<option value="${esc(c.id)}">${esc(c.name)} — ${esc(providerName(c.provider))}</option>`).join("") : `<option value="">No storage connections yet — add one first</option>`;
    }catch(e){ say(message,"error",e.message); }
    const load = async () => { if(!dbSel.value){ result.innerHTML=""; return; } try{ const r = await api("/api/v1/storage/databases/"+encodeURIComponent(dbSel.value)); showBinding(result, r.binding, dbSel.value); if(r.binding?.connectionId) connSel.value = r.binding.connectionId; }catch(e){ say(result,"error",e.message); } };
    dbSel.onchange = load; await load();
    const bindBtn = document.getElementById("sb-bind-db");
    bindBtn.onclick = busy(bindBtn, "Binding…", async () => {
      if(!dbSel.value || !connSel.value) return say(message,"error","Choose a database and a storage connection.");
      try{
        const r = await api("/api/v1/storage/databases/"+encodeURIComponent(dbSel.value)+"/bind",{method:"POST",body:JSON.stringify({connectionId:connSel.value,prefix:"databases/"+dbSel.value+"/"})});
        say(message,"success","Bound. Now press “Test connection” to prove it works.");
        showBinding(result, r.binding, dbSel.value);
      }catch(e){ say(message,"error",e.message); }
    });
  }

  function showBinding(box,binding,dbId){
    if(!binding){ box.innerHTML=`<div class="smartbase-storage-card"><strong>This database is not bound to external storage.</strong></div>`; return; }
    const c=binding.connection, verified=!!binding.last_verified_at;
    box.innerHTML=`
      <div class="smartbase-storage-card">
        <h3>Binding status</h3>
        <div class="smartbase-storage-muted">Connection: <strong>${esc(c?.name || binding.connectionId)}</strong> · Bucket: <strong>${esc(c?.bucket || "unknown")}</strong></div>
        <div class="smartbase-storage-muted">Folder in bucket: <code>${esc(binding.prefix || "")}</code></div>
        <div class="smartbase-storage-muted" style="margin-top:8px">Connection test: <strong>${verified ? "✓ passed "+esc(when(binding.last_verified_at))+(binding.last_verified_ms?" ("+binding.last_verified_ms+" ms)":"") : "not run yet"}</strong></div>
        <div class="smartbase-storage-muted">Last backup: <strong>${binding.last_backup_at ? esc(when(binding.last_backup_at))+" · "+esc(kb(binding.last_backup_bytes||0)) : "none yet"}</strong></div>
        <div id="sb-act-msg" style="margin-top:10px"></div>
        <div class="smartbase-storage-actions">
          <button class="smartbase-storage-btn smartbase-storage-secondary" id="sb-verify">Test connection</button>
          <button class="smartbase-storage-btn smartbase-storage-primary" id="sb-backup">Back up now</button>
          <button class="smartbase-storage-btn smartbase-storage-danger" id="sb-unbind">Unbind</button>
        </div>
        <h3 style="margin-top:18px">Backups in your bucket</h3>
        <div id="sb-backups" class="smartbase-storage-muted">Loading…</div>
      </div>`;
    const msg=document.getElementById("sb-act-msg"), id=encodeURIComponent(dbId);
    const loadBackups = async () => {
      const el=document.getElementById("sb-backups");
      try{
        const r=await api("/api/v1/storage/databases/"+id+"/backups");
        if(!r.backups.length){ el.textContent="No backups yet. Press “Back up now”."; return; }
        el.innerHTML=r.backups.map((b,i)=>`<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid rgba(127,127,127,.2)"><span>${esc(b.key.split("/").pop())} · ${esc(kb(b.bytes))}</span><button class="smartbase-storage-btn smartbase-storage-secondary" data-i="${i}">Download</button></div>`).join("");
        el.querySelectorAll("button[data-i]").forEach(btn=>btn.onclick=async()=>{ try{ const d=await api("/api/v1/storage/databases/"+id+"/backups/download-url",{method:"POST",body:JSON.stringify({key:r.backups[+btn.dataset.i].key})}); window.open(d.url,"_blank","noopener"); }catch(e){ say(msg,"error",e.message); } });
      }catch(e){ say(el,"error",e.message); }
    };
    const verify=document.getElementById("sb-verify"), backup=document.getElementById("sb-backup"), unbind=document.getElementById("sb-unbind");
    verify.onclick = busy(verify, "Testing…", async () => {
      try{ const r=(await api("/api/v1/storage/databases/"+id+"/verify",{method:"POST"})).result;
        msg.innerHTML=`<div class="smartbase-storage-success">✓ Connection works (${r.ms} ms)<br>${r.steps.map(x=>"• "+esc(x)).join("<br>")}</div>`; }
      catch(e){ say(msg,"error",e.message); }
    });
    backup.onclick = busy(backup, "Backing up…", async () => {
      try{ const r=(await api("/api/v1/storage/databases/"+id+"/backup",{method:"POST"})).backup;
        msg.innerHTML=`<div class="smartbase-storage-success">✓ Backup saved to your bucket<br>${r.tables} table(s), ${r.records} record(s), ${esc(kb(r.bytes))}<br><code>${esc(r.key)}</code></div>`; loadBackups(); }
      catch(e){ say(msg,"error",e.message); }
    });
    unbind.onclick = async () => { if(!confirm("Remove the external storage binding from this database? Your backups stay in your bucket.")) return; try{ await api("/api/v1/storage/databases/"+id+"/bind",{method:"DELETE"}); box.innerHTML=`<div class="smartbase-storage-card"><strong>Binding removed.</strong></div>`; }catch(e){ say(msg,"error",e.message); } };
    loadBackups();
  }

  async function renderFilesTab(box){
    box.innerHTML=`<div class="smartbase-storage-card">Loading…</div>`;
    let info; try{ info = await api("/api/v1/files-storage"); }catch(e){ return say(box,"error",e.message); }
    const b = info.binding, conns = info.connections || [], ext = b.mode === "b2";
    box.innerHTML=`
      <div class="smartbase-storage-card">
        <h3>Where should your files be stored?</h3>
        <label style="display:block;margin:12px 0 6px"><input type="radio" name="sb-fmode" value="smartbase" ${ext?"":"checked"}> <strong>Smartbase free storage</strong> — 1 GB, up to 50 MB per file</label>
        <label style="display:block;margin:6px 0"><input type="radio" name="sb-fmode" value="b2" ${ext?"checked":""} ${conns.length?"":"disabled"}> <strong>My Backblaze B2 bucket</strong> — files go straight to your bucket (not counted in the 1 GB)</label>
        <div class="smartbase-storage-field"><select id="sb-fconn" ${conns.length?"":"disabled"}>${conns.length ? conns.map(c=>`<option value="${esc(c.id)}" ${c.id===b.connectionId?"selected":""}>${esc(c.name)} — ${esc(c.bucket)}</option>`).join("") : `<option>Add a storage connection first</option>`}</select></div>
        <div id="sb-fmsg"></div>
        <div class="smartbase-storage-actions">
          <button class="smartbase-storage-btn smartbase-storage-primary" id="sb-fsave">Save location</button>
          ${ext ? `<button class="smartbase-storage-btn smartbase-storage-secondary" id="sb-ftest">Test direct upload</button>` : ""}
        </div>
        <div class="smartbase-storage-muted" style="margin-top:14px">Files you upload from the dashboard go from your browser directly to the bucket, so the bucket needs a <strong>CORS rule</strong> (Backblaze → Buckets → your bucket → CORS Rules → custom):<br>
        Allowed origin <code>${esc(location.origin)}</code> · operations <code>s3_put, s3_get, s3_head</code> · allowed headers <code>*</code> · max age <code>3600</code>.</div>
      </div>`;
    const msg=document.getElementById("sb-fmsg"), save=document.getElementById("sb-fsave");
    save.onclick = busy(save, "Saving…", async () => {
      const mode=document.querySelector('input[name="sb-fmode"]:checked').value;
      try{ await api("/api/v1/files-storage",{method:"PUT",body:JSON.stringify({mode,connectionId:document.getElementById("sb-fconn").value})}); renderFilesTab(box); }
      catch(e){ say(msg,"error",e.message); }
    });
    const test=document.getElementById("sb-ftest");
    if(test) test.onclick = busy(test, "Testing…", async () => {
      try{
        const t = await api("/api/v1/files-storage/test",{method:"POST"});
        let line = `✓ Server check passed (${t.server.ms} ms): a test file was written, found and deleted.`;
        try{
          const r = await fetch(t.browser.url,{method:"PUT",headers:t.browser.headers,body:"smartbase browser test"});
          if(!r.ok) throw new Error("status "+r.status);
          await api("/api/v1/files-storage/test-cleanup",{method:"POST",body:JSON.stringify({key:t.browser.key})});
          msg.innerHTML=`<div class="smartbase-storage-success">${esc(line)}<br>✓ Direct upload from this browser works — dashboard uploads will go straight to your bucket.</div>`;
        }catch(_){
          msg.innerHTML=`<div class="smartbase-storage-error">${esc(line)}<br>✗ Your browser could not upload directly. Add the CORS rule shown below, wait a minute and test again.</div>`;
        }
      }catch(e){ say(msg,"error",e.message); }
    });
  }

  window.smartbaseStoragePanel = (tab) => { openPanel(); const t=document.querySelector('.smartbase-storage-tab[data-tab="'+(tab||"connections")+'"]'); if(t) t.click(); };

  function providerName(id){
    const found=PROVIDERS.find(x=>x[0]===id);
    return found ? found[1] : id;
  }

  function boot(){
    if(!document.body)return;
    launcher();
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",boot);
  }else{
    boot();
  }
})();
