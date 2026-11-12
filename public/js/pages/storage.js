'use strict';
window.PageModules=window.PageModules||{};
window.PageModules.storage={
  async init(){
    const root=document.getElementById('page-container');if(!root)return ()=>{};
    if(!RolePermissions.hasRole('platform')){
      root.innerHTML='<div class="m-8 rounded-xl border p-6">Platform administrator access required.</div>';
      return ()=>{};
    }
    root.innerHTML='<div class="max-w-7xl mx-auto p-6"><div class="mb-6"><h1 class="text-3xl font-semibold">Storage Management</h1><p class="mt-2 text-on-surface-variant">Monitor local database, cloud sync and this browser’s cached state.</p></div><div id="storage-progress" class="hidden mb-4 rounded-lg bg-surface-container p-3">Working…</div><div id="storage-error" class="hidden mb-4 rounded-lg border border-error p-3 text-error"></div><div class="grid gap-5 xl:grid-cols-3"><section id="sqlite-card" class="rounded-xl border border-outline-variant p-5"></section><section id="cloud-card" class="rounded-xl border border-outline-variant p-5"></section><section id="browser-card" class="rounded-xl border border-outline-variant p-5"></section></div></div>';
    const pageContent=root.querySelector('.max-w-7xl');
    const searchSection=document.createElement('section');
    searchSection.id='storage-search';
    searchSection.className='mb-6 rounded-xl border border-outline-variant p-5';
    searchSection.innerHTML='<div><h2 class="text-xl font-semibold">Search stored information</h2><p class="mt-1 text-sm text-on-surface-variant">Search safe fields across local SQLite and Supabase. Related rows are included when they reference a matching record ID. Credential fields are excluded.</p></div><form id="storage-search-form" class="mt-4 flex flex-wrap gap-2"><input id="storage-search-query" type="search" class="min-w-64 flex-1 rounded-lg border border-outline-variant px-3 py-2" placeholder="Search an email, name, phone, ID…" maxlength="200" autocomplete="off"><button id="storage-search-submit" class="rounded-lg bg-primary px-4 py-2 text-on-primary" type="submit">Search</button><button id="storage-search-clear" class="rounded-lg border px-4 py-2" type="button">Clear</button></form><div id="storage-search-status" class="mt-3 text-sm text-on-surface-variant" role="status" aria-live="polite"></div><div id="storage-search-results" class="mt-3 space-y-3"></div>';
    pageContent.insertBefore(searchSection,pageContent.querySelector('.grid'));
    const searchBulkControls=document.createElement('div');
    searchBulkControls.className='mt-3 flex flex-wrap items-center gap-2';
    searchBulkControls.innerHTML='<button id="storage-search-select-all" type="button" class="underline text-sm">Select all removable</button><button id="storage-search-clear-selection" type="button" class="underline text-sm">Clear selection</button><span id="storage-search-selection-count" class="text-sm text-on-surface-variant">0 selected</span><button id="storage-search-remove-local" type="button" class="rounded-lg border border-error px-3 py-2 text-sm text-error" disabled>Remove selected local</button><button id="storage-search-remove-cloud" type="button" class="rounded-lg border border-error px-3 py-2 text-sm text-error" disabled>Remove selected cloud</button>';
    document.getElementById('storage-search-results').before(searchBulkControls);
    const dangerZone=document.createElement('section');
    dangerZone.id='storage-danger-zone';
    dangerZone.className='mt-6 rounded-xl border-2 border-error bg-error-container/30 p-5';
    dangerZone.innerHTML='<div class="flex flex-wrap items-start justify-between gap-4"><div><h2 class="text-xl font-semibold text-error">Danger Zone</h2><p class="mt-2 max-w-3xl text-sm">Factory reset permanently removes tenant users, companies, agencies, assignments, wallets, CRM records, audit history, cloud-sync history, and other company-scoped rows.</p><p class="mt-2 text-sm"><strong>Kept:</strong> the platform admin account, the required default company, system roles, permissions, and schema migrations.</p></div><button id="storage-purge-all" type="button" class="rounded-lg bg-error px-4 py-2 font-semibold text-white">Factory Reset (Purge All Tenant Data)</button></div>';
    pageContent.append(dangerZone);
    const esc=v=>String(v==null?'—':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const bytes=n=>{n=Number(n||0);if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';};
    const progress=document.getElementById('storage-progress');
    const errorEl=document.getElementById('storage-error');
    let orphanRecords=[],syncQueue=[],searchRows=[];
    const updateSearchBulkButtons=()=>{
      const selected=[...root.querySelectorAll('.storage-search-check:checked')];
      const local=selected.filter(box=>box.dataset.source==='local').length,cloud=selected.filter(box=>box.dataset.source==='cloud').length;
      document.getElementById('storage-search-selection-count').textContent=selected.length+' selected ('+local+' local, '+cloud+' cloud)';
      const localButton=document.getElementById('storage-search-remove-local'),cloudButton=document.getElementById('storage-search-remove-cloud');
      localButton.disabled=!local;cloudButton.disabled=!cloud;
      localButton.classList.toggle('opacity-50',!local);cloudButton.classList.toggle('opacity-50',!cloud);
    };
    const moduleForTable={users:'#users',companies:'#organizations',contacts:'#contacts',organizations:'#organizations',leads:'#leads',deals:'#deals',tasks:'#tasks',appointments:'#appointments',invoices:'#customer-bills',payments:'#customer-bills',agencies:'#agency-control'};
    const renderSearchResults=data=>{
      const status=document.getElementById('storage-search-status'),host=document.getElementById('storage-search-results');
      const local=data.local||{},cloud=data.cloud||{},localRows=local.records||[],cloudRows=cloud.records||[];
      status.textContent='Found '+localRows.length+' local and '+cloudRows.length+' cloud record(s).'+((local.truncated||cloud.truncated)?' Results reached the display limit. Refine the search to see more.':'');
      const cloudNotice=!cloud.searched?'<p class="rounded-lg border border-warning/40 bg-warning-container/30 p-3 text-sm">'+esc(cloud.message||(cloud.configured?'Cloud search is unavailable.':'Supabase is not configured.'))+'</p>':'';
      const rows=[...localRows.map(item=>({...item,source:'Local SQLite',sourceKey:'local'})),...cloudRows.map(item=>({...item,source:'Supabase Cloud',sourceKey:'cloud'}))];
      searchRows=rows;
      if(!rows.length){host.innerHTML=cloudNotice+(cloud.searched?'<p class="rounded-lg border border-outline-variant p-4 text-sm">No matching stored information found.</p>':'<p class="rounded-lg border border-outline-variant p-4 text-sm">No local matches found. Cloud results are currently unavailable.</p>');updateSearchBulkButtons();return;}
      host.innerHTML=cloudNotice+rows.map((item,index)=>{
        const data=item.data&&typeof item.data==='object'?item.data:{};
        const json=JSON.stringify(data,null,2),preview=json.length>24000?json.slice(0,24000)+'\\n… (preview shortened)':'';
        const module=moduleForTable[String(item.table||'').toLowerCase()];
        const matched=(item.matchedColumns||[]).map(esc).join(', ');
        return '<article class="rounded-lg border border-outline-variant p-4"><div class="flex flex-wrap items-center justify-between gap-2"><div class="flex items-center gap-2"><input type="checkbox" class="storage-search-check" data-source="'+item.sourceKey+'" data-result-index="'+index+'" '+(item.removable?'':'disabled title="Core or unsupported records are protected"')+'><strong>'+esc(item.table)+'</strong><span class="rounded-full border px-2 py-0.5 text-xs">'+esc(item.source)+'</span><span class="text-xs text-on-surface-variant">'+(item.relation==='linked'?'Related by ID':'Direct match')+(matched?' · '+matched:'')+'</span></div><span class="text-xs text-on-surface-variant">ID: '+esc(item.recordId||'—')+'</span></div><details class="mt-3"><summary class="cursor-pointer text-sm underline">View stored details</summary><pre class="mt-2 max-h-96 overflow-auto rounded bg-surface-container p-3 text-xs">'+esc(preview||json)+'</pre></details><div class="mt-3 flex flex-wrap gap-2"><button type="button" class="storage-copy-details rounded-lg border px-3 py-1.5 text-sm" data-result-index="'+index+'">Copy details</button>'+(module?'<button type="button" class="storage-open-module rounded-lg border px-3 py-1.5 text-sm" data-module="'+module+'">Open '+esc(item.table)+' module</button>':'')+(!item.removable?'<span class="py-1.5 text-xs text-on-surface-variant">Protected core/system record</span>':'')+'</div></article>';
      }).join('');
      host.querySelectorAll('.storage-copy-details').forEach(button=>button.addEventListener('click',async()=>{
        const item=rows[Number(button.dataset.resultIndex)];
        try{await navigator.clipboard.writeText(JSON.stringify({source:item.source,table:item.table,recordId:item.recordId,data:item.data},null,2));toast('success','Record details copied.');}
        catch{toast('error','Clipboard access is unavailable in this browser.');}
      }));
      host.querySelectorAll('.storage-open-module').forEach(button=>button.addEventListener('click',()=>{window.location.hash=button.dataset.module;}));
      host.querySelectorAll('.storage-search-check').forEach(box=>box.addEventListener('change',updateSearchBulkButtons));
      updateSearchBulkButtons();
    };
    document.getElementById('storage-search-form').addEventListener('submit',async event=>{
      event.preventDefault();
      const query=document.getElementById('storage-search-query').value.trim(),status=document.getElementById('storage-search-status'),host=document.getElementById('storage-search-results');
      if(query.length<2){status.textContent='Enter at least 2 characters to search.';host.innerHTML='';return;}
      status.textContent='Searching local and cloud storage…';host.innerHTML='<div class="inline-flex items-center gap-2 rounded-lg border p-3 text-sm"><span class="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"></span>Searching stored records…</div>';
      try{renderSearchResults(await API.get('/storage/search?q='+encodeURIComponent(query)));}
      catch(error){status.textContent='Search failed.';host.innerHTML='<p class="rounded-lg border border-error p-3 text-sm text-error">'+esc(error.message||'Could not search stored records.')+'</p>';}
    });
    document.getElementById('storage-search-clear').addEventListener('click',()=>{document.getElementById('storage-search-query').value='';document.getElementById('storage-search-status').textContent='';document.getElementById('storage-search-results').innerHTML='';searchRows=[];updateSearchBulkButtons();});
    document.getElementById('storage-search-select-all').addEventListener('click',()=>{root.querySelectorAll('.storage-search-check:not(:disabled)').forEach(box=>{box.checked=true;});updateSearchBulkButtons();});
    document.getElementById('storage-search-clear-selection').addEventListener('click',()=>{root.querySelectorAll('.storage-search-check').forEach(box=>{box.checked=false;});updateSearchBulkButtons();});
    const updatePurgeAvailability=()=>{
      const button=document.getElementById('orphan-purge');if(!button)return;
      const eligible=[...root.querySelectorAll('.orphan-check:checked')].some(box=>box.dataset.actionable==='true');
      button.disabled=!eligible;
      button.title=eligible?'Purge selected eligible terminal orphan deals':'Select an eligible terminal orphan deal to enable purge';
      button.classList.toggle('opacity-50',!eligible);
      button.classList.toggle('cursor-not-allowed',!eligible);
    };
    const updateHardDeleteAvailability=()=>{
      const button=document.getElementById('orphan-hard-delete');if(!button)return;
      const eligible=[...root.querySelectorAll('.orphan-check:checked')].some(box=>box.dataset.hardDeletable==='true');
      button.disabled=!eligible;
      button.title=eligible?'Permanently delete selected suspended users':'Select suspended users to enable permanent deletion';
      button.classList.toggle('opacity-50',!eligible);
      button.classList.toggle('cursor-not-allowed',!eligible);
    };
    root.addEventListener('change',event=>{if(event.target.matches('.orphan-check')){updatePurgeAvailability();updateHardDeleteAvailability();}});
    const setBusy=(value,label='Working…')=>{progress.innerHTML=value?'<span class="inline-flex items-center gap-2"><span class="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"></span>'+esc(label)+'</span>':esc(label);progress.classList.toggle('hidden',!value);};
    const toast=(kind,msg)=>window.Toast&&Toast[kind](msg);
    root.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||!root.contains(button))return;
      const actions={
        'orphan-select-all':['.orphan-check',true,'No orphan records to select.'],
        'orphan-clear':['.orphan-check',false,'Orphan selections cleared.'],
        'sync-select-all':['.sync-check',true,'No pending or failed sync records to select.'],
        'sync-clear':['.sync-check',false,'Sync selections cleared.'],
      };
      const action=actions[button.id];if(!action)return;
      const boxes=[...root.querySelectorAll(action[0])];
      boxes.forEach(box=>{box.checked=action[1];});
      if(action[0]==='.orphan-check'){updatePurgeAvailability();updateHardDeleteAvailability();}
      if(!boxes.length)toast('info',action[2]);
    });
    const confirmTyped=(title,message,word='DELETE')=>new Promise(resolve=>{
      let settled=false;const finish=value=>{if(!settled){settled=true;resolve(value);}};
      const modal=new Modal({title,size:'sm',onClose:()=>finish(false),content:'<p class="mb-4">'+esc(message)+'</p><label class="block text-sm mb-2">Type <strong>'+word+'</strong> to continue</label><input id="storage-confirm-word" class="w-full rounded-lg border border-outline p-3" autocomplete="off"><div class="flex justify-end gap-2 mt-5"><button type="button" id="storage-cancel" class="rounded-lg border px-4 py-2">Cancel</button><button type="button" id="storage-confirm" class="rounded-lg bg-error px-4 py-2 text-white" disabled>Confirm</button></div>'});
      modal.open();
      const input=modal.element.querySelector('#storage-confirm-word'),ok=modal.element.querySelector('#storage-confirm');
      input.addEventListener('input',()=>{ok.disabled=input.value!==word;});
      modal.element.querySelector('#storage-cancel').addEventListener('click',()=>modal.close());
      ok.addEventListener('click',()=>{finish(true);modal.close();});
    });
    const removeSearchSelection=async source=>{
      const records=[...root.querySelectorAll('.storage-search-check:checked')]
        .filter(box=>box.dataset.source===source)
        .map(box=>searchRows[Number(box.dataset.resultIndex)])
        .filter(item=>item&&item.removable&&item.recordId)
        .map(item=>({table:item.table,recordId:item.recordId}));
      if(!records.length){toast('info','Select removable records from this source first.');return;}
      const label=source==='local'?'Local SQLite':'Supabase Cloud';
      if(!await confirmTyped('Remove selected '+label+' records','This permanently deletes '+records.length+' selected row(s) from '+label+'. Core accounts, companies, agencies and system tables are protected. If a selected row has dependent records, include those too or the whole operation will be blocked. Type DELETE SELECTED DATA to continue.','DELETE SELECTED DATA'))return;
      setBusy(true,'Removing selected '+label+' records…');
      try{
        const result=await API.post('/storage/search/remove',{source,records,confirm:'DELETE SELECTED DATA'});
        toast('success','Removed '+Number(result.removed||0)+' selected row(s) from '+label+'.');
        await load();
        document.getElementById('storage-search-form').requestSubmit();
      }catch(error){toast('error',error.message||'Bulk removal failed; selected rows were preserved.');}
      finally{setBusy(false);}
    };
    document.getElementById('storage-search-remove-local').addEventListener('click',()=>removeSearchSelection('local'));
    document.getElementById('storage-search-remove-cloud').addEventListener('click',()=>removeSearchSelection('cloud'));
    const confirmPurgeAll=()=>new Promise(resolve=>{
      let settled=false;const finish=value=>{if(!settled){settled=true;resolve(value);}};
      const modal=new Modal({title:'Factory Reset — Purge All Tenant Data',size:'md',onClose:()=>finish(null),content:'<div class="space-y-3 text-sm"><p class="font-semibold text-error">This permanently deletes tenant data from the local CRM database.</p><p><strong>Will be deleted:</strong> all non-admin users, tenant companies, agencies, assignments, wallets, CRM records, audit logs, cloud sync logs, and other company-scoped data.</p><p><strong>Will be preserved:</strong> your platform admin account, the required <code>default</code> company, system roles, permissions, and migrations.</p><label class="flex items-start gap-2 rounded-lg border p-3"><input id="storage-cloud-purge" type="checkbox" class="mt-1"><span><strong>Also purge from Supabase Cloud (Hard Delete)</strong><small class="mt-1 block">If checked, the server calls the transactional cloud purge function. If it is unavailable or fails, the local transaction is rolled back. Cloud purge and SQLite cannot share one distributed transaction.</small></span></label><p>If unchecked, no deletion request is sent to Supabase. Local sync retries are paused while the local purge runs.</p><label class="block pt-2">Type <strong>DELETE ALL DATA</strong> to enable confirmation.</label><input id="storage-purge-word" class="w-full rounded-lg border border-outline p-3" autocomplete="off"><div class="flex justify-end gap-2 pt-3"><button type="button" id="storage-purge-cancel" class="rounded-lg border px-4 py-2">Cancel</button><button type="button" id="storage-purge-confirm" class="rounded-lg bg-error px-4 py-2 font-semibold text-white" disabled>Confirm Purge</button></div></div>'});
      modal.open();
      const input=modal.element.querySelector('#storage-purge-word'),cloud=modal.element.querySelector('#storage-cloud-purge'),ok=modal.element.querySelector('#storage-purge-confirm');
      input.addEventListener('input',()=>{ok.disabled=input.value!=='DELETE ALL DATA';});
      modal.element.querySelector('#storage-purge-cancel').addEventListener('click',()=>modal.close());
      ok.addEventListener('click',()=>{if(input.value!=='DELETE ALL DATA')return;finish({alsoPurgeSupabase:cloud.checked});modal.close();});
    });
    const browserMetrics=async()=>{
      let bytesUsed=0;const keys=[];
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i),value=localStorage.getItem(key)||'';
        bytesUsed+=new TextEncoder().encode(key+value).length;
        if(/setting|config|preference/i.test(key))keys.push(key);
      }
      let quota=null;
      try{const estimate=await navigator.storage?.estimate?.();if(estimate&&estimate.quota)quota=estimate.quota;}catch{}
      let sessionText='No CRM session cached',stale=0;
      const token=localStorage.getItem('crm_token');
      if(token){
        try{const payload=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));const expired=Number(payload.exp||0)*1000<=Date.now();stale=expired?1:0;sessionText=expired?'Cached CRM session is expired':'Current CRM session expires '+new Date(payload.exp*1000).toLocaleString();}
        catch{stale=1;sessionText='Cached CRM session could not be validated locally';}
      }
      return {bytesUsed,quota,keys,stale,sessionText,itemCount:localStorage.length};
    };
    const renderBrowser=async()=>{
      const m=await browserMetrics();
      document.getElementById('browser-card').innerHTML='<h2 class="text-xl font-semibold">Browser Cache (LocalStorage)</h2><p class="mt-1 text-sm text-on-surface-variant">Measurements apply to this browser only.</p><dl class="mt-4 grid grid-cols-2 gap-3"><dt>Estimated LocalStorage</dt><dd class="text-right font-medium">'+bytes(m.bytesUsed)+'</dd><dt>Browser Origin Quota (Estimate)</dt><dd class="text-right font-medium">'+(m.quota?bytes(m.quota):'Unavailable')+'</dd><dt>Stored keys</dt><dd class="text-right font-medium">'+m.itemCount+'</dd><dt>Stale cached sessions</dt><dd class="text-right font-medium">'+m.stale+'</dd></dl><p class="mt-4 text-sm">'+esc(m.sessionText)+'</p><h3 class="mt-4 font-medium">Cached settings keys</h3><ul class="mt-2 list-disc pl-5 text-sm">'+(m.keys.length?m.keys.map(k=>'<li>'+esc(k)+'</li>').join(''):'<li>None detected</li>')+'</ul>';
    };
    const load=async()=>{
      errorEl.classList.add('hidden');setBusy(true,'Loading storage metrics…');
      try{
        const results=await Promise.all([API.get('/storage/sqlite'),API.get('/storage/supabase'),API.get('/storage/orphans')]);
        const sqlite=results[0],cloud=results[1];orphanRecords=(results[2].records||[]).map(r=>({...r,suspendable:r.suspendable??(r.type==='user'&&r.deactivatable===true)}));syncQueue=cloud.queue||[];
        const labels={companies:'Companies',users:'Users',agencies:'Agencies',customerTenantAgencies:'Customer assignments',contacts:'Contacts',organizations:'Organizations',leads:'Leads',deals:'Deals',tasks:'Tasks',appointments:'Appointments',invoices:'Invoices',payments:'Payments',auditLogs:'Audit logs'};
        const rows=Object.entries(labels).map(([key,label])=>'<tr class="border-t"><td class="py-1">'+label+'</td><td class="py-1 text-right">'+Number(sqlite.rowCounts?.[key]||0).toLocaleString()+'</td></tr>').join('');
        const soft=sqlite.softDeleted||{};
        document.getElementById('sqlite-card').innerHTML='<div class="flex items-center justify-between"><h2 class="text-xl font-semibold">Local Database (SQLite)</h2><button id="storage-refresh" class="underline text-sm">Refresh</button></div><p class="mt-3 text-2xl font-semibold">'+bytes(sqlite.databaseSizeBytes)+'</p><p class="text-xs text-on-surface-variant">Total Database Size'+(sqlite.walSizeBytes?' · Includes '+bytes(sqlite.walSizeBytes)+' WAL file':'')+'</p><div class="mt-4 max-h-64 overflow-auto"><table class="w-full text-sm"><thead><tr><th class="text-left">Table</th><th class="text-right">Rows</th></tr></thead><tbody>'+rows+'</tbody></table></div><h3 class="mt-4 font-medium">Inactive / soft-deleted markers (review only)</h3><p class="mt-2 text-sm">Users: '+(soft.inactiveUsers||0)+' · Agencies: '+(soft.terminatedAgencies||0)+' · Companies: '+(soft.inactiveCompanies||0)+'</p><div class="mt-4 flex flex-wrap gap-2"><button id="storage-vacuum" class="rounded-lg border px-3 py-2 text-sm">Vacuum / Optimize</button><button id="storage-clear-sessions" class="rounded-lg border px-3 py-2 text-sm">Clear stale sessions ('+(sqlite.sessions?.expired||0)+')</button></div><h3 class="mt-5 font-medium">Orphan / soft-deleted records</h3><p class="mt-1 text-sm">'+(results[2].actionableCount||0)+' terminal deal candidates · '+(results[2].reviewOnlyCount||0)+' records marked review-only</p><div class="mt-2 flex flex-wrap gap-2"><button type="button" id="orphan-select-all" class="underline text-sm">Select All</button><button type="button" id="orphan-clear" class="underline text-sm">Clear All</button><button id="orphan-preview" class="rounded-lg border px-3 py-1 text-sm">Dry Run Preview</button><button id="orphan-suspend" class="rounded-lg border px-3 py-1 text-sm">Suspend Selected</button><button id="orphan-purge" class="rounded-lg bg-error px-3 py-1 text-sm text-white">Purge Selected</button></div><p class="mt-1 text-xs text-on-surface-variant">Suspension keeps user records and revokes their active sessions. Only eligible user records can be suspended.</p><div class="mt-2 max-h-64 overflow-auto"><table class="w-full text-left text-sm"><thead><tr><th></th><th>Record</th><th>Status</th><th>Actionability</th></tr></thead><tbody>'+orphanRecords.map(r=>'<tr class="border-t"><td class="py-2"><input type="checkbox" class="orphan-check" data-actionable="'+(r.actionable?'true':'false')+'" data-suspendable="'+(r.suspendable?'true':'false')+'" value="'+esc(r.id)+'"></td><td>'+esc(r.label)+'<small class="block text-on-surface-variant">'+esc(r.type)+' · '+esc(r.id)+'</small></td><td>'+esc(r.status)+'</td><td>'+(r.actionable?'Purges only if still orphaned and terminal':r.suspendable?'Can be suspended; record is retained':'Review only; deletion and suspension are unavailable')+'</td></tr>').join('')+'<tr><td colspan="4" class="py-2">'+(orphanRecords.length?'':'No orphan candidates found.')+'</td></tr></tbody></table></div>';
        const hardDeleteButton=document.createElement('button');hardDeleteButton.type='button';hardDeleteButton.id='orphan-hard-delete';hardDeleteButton.className='rounded-lg border border-error px-3 py-1 text-sm text-error';hardDeleteButton.textContent='Hard Delete Suspended';
        document.getElementById('orphan-purge').before(hardDeleteButton);
        root.querySelectorAll('.orphan-check').forEach((box,index)=>{box.dataset.hardDeletable=String(Boolean(orphanRecords[index]?.hardDeletable));});
        updatePurgeAvailability();updateHardDeleteAvailability();
        document.getElementById('cloud-card').innerHTML='<div class="flex items-center justify-between"><h2 class="text-xl font-semibold">Cloud Sync (Supabase)</h2><button id="cloud-refresh" class="underline text-sm">Refresh</button></div><p class="mt-3 text-sm">Synced agency mirrors: <strong>'+Number(cloud.synced||0)+'</strong></p><div class="mt-2 grid grid-cols-2 gap-3"><p>Pending <strong>'+Number(cloud.pending||0)+'</strong></p><p>Failed <strong>'+Number(cloud.failed||0)+'</strong></p></div><p class="mt-2 text-xs text-on-surface-variant">'+(cloud.configured?'Counts come from the local sync ledger.':'Sync ledger unavailable')+'</p><div class="mt-3 flex items-center gap-3"><button id="cloud-verify" class="rounded-lg border px-3 py-2 text-sm">Verify Cloud Connection</button><span id="cloud-connection-status" class="text-sm text-on-surface-variant" role="status">Not verified</span></div><div class="mt-4 flex gap-2"><button type="button" id="sync-select-all" class="underline text-sm">Select All</button><button type="button" id="sync-clear" class="underline text-sm">Clear All</button><button id="sync-retry" class="rounded-lg border px-3 py-1 text-sm">Retry Selected</button></div><div class="mt-2 max-h-64 overflow-auto"><table class="w-full text-left text-sm"><thead><tr><th></th><th>Agency</th><th>Status</th><th>Attempts / error</th></tr></thead><tbody>'+syncQueue.map(r=>'<tr class="border-t"><td class="py-2"><input type="checkbox" class="sync-check" value="'+esc(r.agencyId)+'"></td><td>'+esc(r.agencyName||r.agencyId)+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.attempts)+' / '+esc(r.errorMessage)+'</td></tr>').join('')+'<tr><td colspan="4" class="py-2">'+(syncQueue.length?'':'No pending or failed sync records.')+'</td></tr></tbody></table></div><h3 class="mt-4 font-medium">Recent failed attempts</h3><p class="mt-1 text-sm">'+(cloud.recentFailures||[]).length+' failure log entries loaded</p>';
        await renderBrowser();
        document.getElementById('storage-refresh').onclick=load;document.getElementById('cloud-refresh').onclick=load;
        document.getElementById('storage-purge-all').onclick=async()=>{
          const confirmation=await confirmPurgeAll();if(!confirmation)return;
          setBusy(true,'Purging tenant data…');
          try{
            const result=await API.post('/storage/purge-all-data',{confirm:'DELETE ALL DATA',alsoPurgeSupabase:confirmation.alsoPurgeSupabase});
            const suffix=result.cloudPurged?' Supabase cloud data was also purged.':'';
            const vacuumNote=result.vacuumed?' Database vacuum completed.':' Purge completed, but database vacuum did not finish.';
            toast('success',(result.summary||'Factory reset completed.')+suffix+vacuumNote);
            await load();
          }catch(e){toast('error',e.message||'Factory reset failed; local data was rolled back.');}
          finally{setBusy(false);}
        };
        document.getElementById('cloud-verify').onclick=async()=>{const button=document.getElementById('cloud-verify'),status=document.getElementById('cloud-connection-status');button.disabled=true;status.textContent='Checking…';status.className='text-sm text-on-surface-variant';try{const result=await API.get('/storage/supabase/verify');status.textContent=result.connected?'Connected':'Disconnected';status.className='text-sm font-medium '+(result.connected?'text-success':'text-error');}catch(e){status.textContent='Disconnected';status.className='text-sm font-medium text-error';}finally{button.disabled=false;}};
        document.getElementById('orphan-preview').onclick=async()=>{
          const ids=[...document.querySelectorAll('.orphan-check:checked')].map(x=>x.value);if(!ids.length)return toast('error','Select at least one orphan record.');
          setBusy(true,'Revalidating selected orphan records…');
          try{const result=await API.post('/storage/orphans/purge',{ids,dryRun:true});toast('success',result.eligible+' record(s) remain eligible; '+result.skipped.length+' will be skipped.');}
          catch(e){toast('error',e.message||'Preview failed.');}finally{setBusy(false);}
        };
        document.getElementById('orphan-suspend').onclick=async()=>{
          const selected=[...document.querySelectorAll('.orphan-check:checked')];if(!selected.length)return toast('error','Select at least one review-only record.');
          const ids=selected.filter(x=>x.dataset.suspendable==='true').map(x=>x.value),skipped=selected.length-ids.length;
          if(!ids.length)return toast('error','The selected records are already suspended or otherwise not eligible. No records were changed.');
          const skipNote=skipped?' '+skipped+' selected record(s) are not suspendable and will be left unchanged.':'';
          if(!await confirmTyped('Suspend selected records','This preserves the selected user records and revokes their active sessions.'+skipNote,'SUSPEND'))return;
          setBusy(true,'Suspending selected user records…');
          try{const result=await API.post('/storage/orphans/suspend',{ids,confirm:'SUSPEND'});const totalSkipped=result.skipped.length+skipped;toast(result.suspended?'success':'error','Suspended '+result.suspended+' record(s); '+totalSkipped+' were left unchanged.');if(result.suspended)document.querySelectorAll('.orphan-check').forEach(x=>{x.checked=false;});await load();}
          catch(e){toast('error',e.message||'Suspension failed.');}finally{setBusy(false);}
        };
        document.getElementById('orphan-hard-delete').onclick=async()=>{
          const selected=[...document.querySelectorAll('.orphan-check:checked')],ids=selected.filter(x=>x.dataset.hardDeletable==='true').map(x=>x.value);
          if(!ids.length)return toast('error','Select at least one suspended user to permanently delete.');
          const skipCount=selected.length-ids.length;
          const warning='This permanently deletes '+ids.length+' suspended user record(s), including their login sessions and user-role links. Audit history is retained with the deleted user reference removed.'+(skipCount?' '+skipCount+' selected record(s) are not suspended users and will be left unchanged.':'');
          if(!await confirmTyped('Permanently delete suspended users',warning,'HARD DELETE'))return;
          setBusy(true,'Permanently deleting selected suspended users…');
          try{const result=await API.post('/storage/orphans/hard-delete',{ids,confirm:'HARD DELETE'});const skipped=result.skipped.length+skipCount;toast(result.deleted?'success':'error','Permanently deleted '+result.deleted+' user record(s); '+skipped+' were left unchanged.');if(result.deleted)document.querySelectorAll('.orphan-check').forEach(x=>{x.checked=false;});await load();}
          catch(e){toast('error',e.message||'Permanent deletion failed.');}finally{setBusy(false);}
        };
        document.getElementById('orphan-purge').onclick=async()=>{
          const selected=[...document.querySelectorAll('.orphan-check:checked')];if(!selected.length)return toast('error','Select at least one orphan record.');
          const reviewOnly=selected.filter(x=>x.dataset.actionable!=='true').length;
          const ids=selected.filter(x=>x.dataset.actionable==='true').map(x=>x.value);
          if(!ids.length)return toast('error',reviewOnly+' selected record(s) are review-only. Only terminal orphan deals can be purged.');
          const reviewNote=reviewOnly?' '+reviewOnly+' review-only record(s) will be left untouched.':'';
          const ok=await confirmTyped('Purge orphaned deals','This permanently deletes only selected terminal deals whose tenant company is still missing and which have no foreign-key dependents.'+reviewNote);
          if(!ok)return;setBusy(true,'Revalidating and purging orphan records…');
          try{const result=await API.post('/storage/orphans/purge',{ids,confirm:'DELETE'});const skipped=result.skipped.length+reviewOnly;if(result.deleted>0)toast('success','Successfully purged '+result.deleted+' orphaned record(s); skipped '+skipped+'.');else toast('error','Nothing was purged. '+skipped+' selected record(s) were not eligible and were left untouched.');await load();}
          catch(e){toast('error',e.message||'Purge failed.');}finally{setBusy(false);}
        };
        document.getElementById('storage-vacuum').onclick=async()=>{if(!await confirmTyped('Optimize local database','VACUUM rebuilds the local SQLite database file.'))return;setBusy(true,'Optimizing SQLite database…');try{const r=await API.post('/storage/sqlite/optimize',{confirm:'DELETE'});toast('success','Database optimized: '+bytes(r.beforeBytes)+' → '+bytes(r.afterBytes)+'.');await load();}catch(e){toast('error',e.message||'Database optimization failed.');}finally{setBusy(false);}};
        document.getElementById('storage-clear-sessions').onclick=async()=>{if(!await confirmTyped('Clear stale sessions','Only expired sessions and revoked session records older than 30 days will be removed. Active sessions are preserved.'))return;setBusy(true,'Clearing expired session records…');try{const r=await API.post('/storage/sessions/clear',{confirm:'DELETE'});toast('success','Cleared '+r.deleted+' stale session record(s).');await load();}catch(e){toast('error',e.message||'Session cleanup failed.');}finally{setBusy(false);}};
        document.getElementById('sync-retry').onclick=async()=>{const agencyIds=[...document.querySelectorAll('.sync-check:checked')].map(x=>x.value);if(!agencyIds.length)return toast('error','Select at least one pending or failed sync item.');if(!await confirmTyped('Retry cloud sync','Retry the selected pending or failed agency sync entries?','RETRY'))return;setBusy(true,'Retrying selected Supabase sync items…');try{const r=await API.post('/storage/supabase/retry',{agencyIds,confirm:'RETRY'});toast('success','Retried '+r.retried+' cloud sync item(s).');await load();}catch(e){toast('error',e.message||'Cloud retry failed.');}finally{setBusy(false);}};
      }catch(err){errorEl.textContent=err.message||'Could not load storage metrics.';errorEl.classList.remove('hidden');}
      finally{setBusy(false);}
    };
    await load();
    return ()=>{};
  }
};
