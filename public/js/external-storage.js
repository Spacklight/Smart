
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

  async function renderDatabase(box){
    box.innerHTML=`
      <div class="smartbase-storage-card">
        <h3>Connect a Smartbase database to external storage</h3>
        <div class="smartbase-storage-muted">
          Enter the database ID and select one of your storage connections.
        </div>

        <div class="smartbase-storage-field" style="margin-top:15px">
          <label>Database ID</label>
          <input id="sb-db-id" placeholder="db_..." required>
        </div>

        <div class="smartbase-storage-field">
          <label>Storage connection</label>
          <select id="sb-db-connection"></select>
        </div>

        <div class="smartbase-storage-field">
          <label>Storage prefix</label>
          <input id="sb-db-prefix" placeholder="databases/db_.../">
        </div>

        <div id="sb-db-message"></div>

        <div class="smartbase-storage-actions">
          <button class="smartbase-storage-btn smartbase-storage-primary" id="sb-bind-db">
            Bind Database
          </button>
          <button class="smartbase-storage-btn smartbase-storage-secondary" id="sb-check-db">
            Check Binding
          </button>
          <button class="smartbase-storage-btn smartbase-storage-danger" id="sb-unbind-db">
            Unbind
          </button>
        </div>

        <div id="sb-db-result" style="margin-top:15px"></div>
      </div>
    `;

    const select=document.getElementById("sb-db-connection");

    try{
      const data=await api("/api/v1/storage/connections");
      const connections=data.connections||[];

      if(!connections.length){
        select.innerHTML=`<option value="">No storage connections available</option>`;
      }else{
        select.innerHTML=connections.map(c=>
          `<option value="${esc(c.id)}">${esc(c.name)} — ${esc(providerName(c.provider))}</option>`
        ).join("");
      }
    }catch(e){
      select.innerHTML=`<option value="">Could not load connections</option>`;
    }

    const message=document.getElementById("sb-db-message");
    const result=document.getElementById("sb-db-result");
    const dbInput=document.getElementById("sb-db-id");
    const prefixInput=document.getElementById("sb-db-prefix");

    document.getElementById("sb-bind-db").onclick=async()=>{
      const dbId=dbInput.value.trim();
      const connectionId=select.value;

      if(!dbId||!connectionId){
        message.innerHTML=`<div class="smartbase-storage-error">Database ID and storage connection are required.</div>`;
        return;
      }

      try{
        const r=await api("/api/v1/storage/databases/"+encodeURIComponent(dbId)+"/bind",{
          method:"POST",
          body:JSON.stringify({
            connectionId,
            prefix:prefixInput.value.trim() || ("databases/"+dbId+"/")
          })
        });

        message.innerHTML=`<div class="smartbase-storage-success">Database connected to external storage.</div>`;
        showBinding(result,r.binding);
      }catch(e){
        message.innerHTML=`<div class="smartbase-storage-error">${esc(e.message)}</div>`;
      }
    };

    document.getElementById("sb-check-db").onclick=async()=>{
      const dbId=dbInput.value.trim();
      if(!dbId){
        message.innerHTML=`<div class="smartbase-storage-error">Enter a database ID.</div>`;
        return;
      }

      try{
        const r=await api("/api/v1/storage/databases/"+encodeURIComponent(dbId));
        showBinding(result,r.binding);

        if(r.binding?.prefix) prefixInput.value=r.binding.prefix;
        if(r.binding?.connectionId) select.value=r.binding.connectionId;

        message.innerHTML=`<div class="smartbase-storage-success">Binding loaded.</div>`;
      }catch(e){
        message.innerHTML=`<div class="smartbase-storage-error">${esc(e.message)}</div>`;
      }
    };

    document.getElementById("sb-unbind-db").onclick=async()=>{
      const dbId=dbInput.value.trim();
      if(!dbId)return;

      if(!confirm("Remove the external storage binding from this database?"))return;

      try{
        await api("/api/v1/storage/databases/"+encodeURIComponent(dbId)+"/bind",{
          method:"DELETE"
        });
        message.innerHTML=`<div class="smartbase-storage-success">Database storage binding removed.</div>`;
        result.innerHTML="";
      }catch(e){
        message.innerHTML=`<div class="smartbase-storage-error">${esc(e.message)}</div>`;
      }
    };
  }

  function showBinding(box,binding){
    if(!binding){
      box.innerHTML=`
        <div class="smartbase-storage-card">
          <strong>No external storage is currently bound.</strong>
        </div>`;
      return;
    }

    const c=binding.connection;

    box.innerHTML=`
      <div class="smartbase-storage-card">
        <h3>Current Storage Binding</h3>
        <div class="smartbase-storage-muted">
          Status: <strong>${esc(binding.status||"connected")}</strong>
        </div>
        <div class="smartbase-storage-muted">
          Connection: ${esc(c?.name || binding.connectionId)}
        </div>
        <div class="smartbase-storage-muted">
          Provider: ${esc(c?.provider || "unknown")}
        </div>
        <div class="smartbase-storage-muted">
          Bucket: ${esc(c?.bucket || "unknown")}
        </div>
        <div class="smartbase-storage-muted">
          Prefix: ${esc(binding.prefix || "")}
        </div>
      </div>
    `;
  }

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
