const DB_NAME='famaferFotoCantiere';
const DB_VERSION=5;
const STORE='photos';
const SETTINGS_STORE='settings';
const APP_VERSION='5.0.0';

let db=null,currentPosition=null,map=null,markersLayer=null;
let activeTags=new Set();
let mapTagFilter=new Set();
let googleTokenClient=null,googleAccessToken=null;
let settings={};

const predefinedTags=[
 'ringhiera','scala','soppalco','tettoia','pensilina','parapetto',
 'carpenteria','carpenteria strutturale','capannone','cancello','recinzione',
 'grigliato','passerella','trave','pilastro','piastre','bulloni','gradini',
 'acciaio','inox','alluminio','zincato','verniciato','grezzo',
 'interno','esterno','montaggio','installato','completato','dettaglio',
 'copertura','facciata','struttura','manufatto metallico','da classificare'
];

document.addEventListener('DOMContentLoaded',init);

async function init(){
  db=await openDB();
  settings=await loadSettings();
  bindNavigation();bindCamera();bindModal();bindSettings();
  renderTagFilters();registerServiceWorker();requestLocation();
  await refreshUI();
  window.addEventListener('online',()=>syncPending(false));
  if(navigator.onLine) setTimeout(()=>syncPending(false),1200);
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      let s;
      if(!d.objectStoreNames.contains(STORE)){
        s=d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
        s.createIndex('createdAt','createdAt');
      }else s=e.target.transaction.objectStore(STORE);

      // Migrazione non distruttiva: nessuna delete/clear dello store foto.
      if(!s.indexNames.contains('syncStatus')) s.createIndex('syncStatus','syncStatus',{unique:false});

      if(!d.objectStoreNames.contains(SETTINGS_STORE)){
        d.createObjectStore(SETTINGS_STORE,{keyPath:'key'});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

function txStore(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function addPhoto(record){return reqPromise(txStore(STORE,'readwrite').add(record))}
function putPhoto(record){return reqPromise(txStore(STORE,'readwrite').put(record))}
function getAllPhotos(){return reqPromise(txStore(STORE).getAll()).then(a=>a.sort((x,y)=>y.createdAt-x.createdAt))}
function reqPromise(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}

async function loadSettings(){
  const saved=await reqPromise(txStore(SETTINGS_STORE).get('config')).catch(()=>null);
  return Object.assign({},window.FM_FOTO_DEFAULTS||{},saved?.value||{});
}
async function saveSettings(){
  await reqPromise(txStore(SETTINGS_STORE,'readwrite').put({key:'config',value:settings,updatedAt:Date.now()}));
}

function requestLocation(){
  const dot=$('gpsDot'),title=$('gpsTitle'),text=$('gpsText');
  if(!navigator.geolocation){
    dot.className='status-dot err';title.textContent='GPS non disponibile';text.textContent='Browser non compatibile';return;
  }
  navigator.geolocation.getCurrentPosition(pos=>{
    currentPosition={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,capturedAt:Date.now()};
    dot.className='status-dot ok';title.textContent='Posizione acquisita';text.textContent=`± ${Math.round(pos.coords.accuracy)} m`;
  },()=>{
    dot.className='status-dot err';title.textContent='Posizione negata';text.textContent='Abilita il GPS';
  },{enableHighAccuracy:true,timeout:12000,maximumAge:20000});
}

function bindCamera(){
  $('cameraInput').addEventListener('change',async e=>{
    const file=e.target.files?.[0]; if(!file)return;
    if(!currentPosition){
      requestLocation(); alert('Attendo la posizione GPS. Consenti la localizzazione e riprova.');
      e.target.value=''; return;
    }
    const image=await compressImage(file,1800,.82);
    let ai=null, tags=automaticFallbackTags(file.name), aiStatus='fallback';
    try{
      ai=await classifyWithAI(image);
      if(ai?.tags?.length){tags=normalizeTags(ai.tags);aiStatus='classified'}
    }catch(err){
      console.warn('AI fallback',err);
      $('aiDot').className='status-dot err';$('aiStatus').textContent='AI non disponibile · fallback';
    }
    const rec={
      image,createdAt:Date.now(),lat:currentPosition.lat,lng:currentPosition.lng,accuracy:currentPosition.accuracy,
      tags,aiStatus,
      aiConfidence:(ai&&Number.isFinite(Number(ai.confidence)))?Number(ai.confidence):null,
      aiSummary:ai?.summary?String(ai.summary).slice(0,280):'',
      syncStatus:'pending',driveFileId:'',driveWebViewLink:'',schemaVersion:4,appVersion:APP_VERSION
    };
    const id=await addPhoto(rec); rec.id=id;
    await refreshUI();
    showLastResult(tags,aiStatus==='classified'?'Analizzata dall’AI · sincronizzazione in coda':'AI non attiva · tag provvisori locali · sincronizzazione in coda');
    e.target.value='';
    if(navigator.onLine)syncPending(false);
  });
}
function compressImage(file,maxSide=1800,quality=.82){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();r.onload=()=>{const img=new Image();img.onload=()=>{
      let w=img.width,h=img.height;if(Math.max(w,h)>maxSide){const s=maxSide/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s)}
      const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
      resolve(c.toDataURL('image/jpeg',quality));
    };img.onerror=reject;img.src=r.result};r.onerror=reject;r.readAsDataURL(file)
  });
}

function automaticFallbackTags(filename=''){
  const low=filename.toLowerCase(),out=[];
  const map={
    'ringhiera':'ringhiera','scala':'scala','soppalco':'soppalco','tettoia':'tettoia',
    'pensilina':'pensilina','parapetto':'parapetto','cancello':'cancello',
    'grigliato':'grigliato','passerella':'passerella','zinc':'zincato',
    'inox':'inox','vernici':'verniciato'
  };
  Object.entries(map).forEach(([k,v])=>{if(low.includes(k))out.push(v)});
  // Fallback is intentionally generic: it must never simulate AI vision.
  if(!out.length)out.push('da classificare');
  return [...new Set(out)].slice(0,5);
}
function normalizeTags(tags){return [...new Set(tags.map(x=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,10)}

async function classifyWithAI(dataUrl){
  if(!settings.aiEndpoint)return null;
  $('aiDot').className='status-dot wait';$('aiStatus').textContent='Analisi AI…';
  const res=await fetch(settings.aiEndpoint,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      image:dataUrl,allowedTags:predefinedTags,
      instruction:'Analizza la fotografia di carpenteria metallica FAMAFER. Identifica solo elementi visibili. Restituisci JSON con tags, confidence e summary.'
    })
  });
  if(!res.ok)throw new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data=await res.json();
  if(!Array.isArray(data.tags))throw new Error('AI: risposta senza tags');
  data.tags=normalizeTags(data.tags);
  $('aiDot').className='status-dot ok';$('aiStatus').textContent='AI attiva';
  return data;
}
async function refreshUI(){
  const photos=await getAllPhotos();
  $('photoCount').textContent=photos.length;
  $('pendingCount').textContent=photos.filter(p=>p.syncStatus!=='synced').length;
  renderQueue(photos);
}

function showLastResult(tags,msg){
  $('lastTags').innerHTML=tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('');
  $('lastSyncInfo').textContent=msg;$('lastResult').classList.remove('hidden');
  setTimeout(()=>$('lastResult').classList.add('hidden'),6500)
}

function bindNavigation(){
  document.querySelectorAll('.nav-btn').forEach(btn=>btn.onclick=async()=>{
    document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));btn.classList.add('active');
    document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));$(btn.dataset.view).classList.add('active');
    if(btn.dataset.view==='mapView')await renderMap();
    if(btn.dataset.view==='tagsView')await renderGallery();
    if(btn.dataset.view==='syncView')await refreshUI();
  });
}

async function renderMap(){
  const all=(await getAllPhotos()).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng));
  const photos=all.filter(p=>[...mapTagFilter].every(t=>(p.tags||[]).includes(t)));
  $('mapEmpty').classList.toggle('hidden',photos.length>0);
  if(!map){
    map=L.map('map').setView([45.55,10.2],8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
    markersLayer=L.layerGroup().addTo(map);
    $('locateBtn').onclick=()=>currentPosition?map.setView([currentPosition.lat,currentPosition.lng],16):requestLocation();
  }
  renderMapFilterBar();
  setTimeout(()=>map.invalidateSize(),100);markersLayer.clearLayers();
  const groups=groupNearby(photos,25),bounds=[];
  groups.forEach(g=>{
    const lat=g.reduce((s,p)=>s+p.lat,0)/g.length,lng=g.reduce((s,p)=>s+p.lng,0)/g.length;bounds.push([lat,lng]);
    const first=g[0],tags=[...new Set(g.flatMap(p=>p.tags||[]))].slice(0,7);
    L.marker([lat,lng]).addTo(markersLayer).bindPopup(`<strong>${g.length} ${g.length===1?'foto':'foto'}</strong><br>${new Date(first.createdAt).toLocaleString('it-IT')}<br>${tags.map(esc).join(' · ')}<br><img src="${first.image}">`);
  });
  if(bounds.length===1)map.setView(bounds[0],16);else if(bounds.length>1)map.fitBounds(bounds,{padding:[25,25]});
}
function renderMapFilterBar(){
  const host=document.getElementById('mapTagBar'); if(!host)return;
  const common=['ringhiera','scala','soppalco','tettoia','parapetto','carpenteria strutturale','zincato','verniciato','installato'];
  host.innerHTML=`<button class="filter-chip ${mapTagFilter.size===0?'active':''}" data-map-tag="">Tutte</button>`+
    common.map(t=>`<button class="filter-chip ${mapTagFilter.has(t)?'active':''}" data-map-tag="${t}">${t}</button>`).join('');
  host.onclick=async ev=>{
    const b=ev.target.closest('[data-map-tag]'); if(!b)return;
    const tag=b.dataset.mapTag;
    if(!tag)mapTagFilter.clear(); else if(mapTagFilter.has(tag))mapTagFilter.delete(tag); else mapTagFilter.add(tag);
    await renderMap();
  };
}
function groupNearby(photos,max){const gs=[];for(const p of photos){let g=gs.find(x=>dist(p.lat,p.lng,x[0].lat,x[0].lng)<=max);g?g.push(p):gs.push([p])}return gs}
function dist(a,b,c,d){const R=6371000,r=x=>x*Math.PI/180,da=r(c-a),db=r(d-b),h=Math.sin(da/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(db/2)**2;return 2*R*Math.asin(Math.sqrt(h))}

function renderTagFilters(){
  const host=$('tagFilters');
  host.innerHTML=`<button class="filter-chip active" data-tag="">Tutte</button>`+
    predefinedTags.map(t=>`<button class="filter-chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('');

  host.onclick=async e=>{
    const b=e.target.closest('.filter-chip');
    if(!b)return;

    const tag=b.dataset.tag||'';
    const allBtn=host.querySelector('[data-tag=""]');

    if(!tag){
      activeTags.clear();
      host.querySelectorAll('.filter-chip').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
    }else{
      allBtn?.classList.remove('active');

      if(activeTags.has(tag)){
        activeTags.delete(tag);
        b.classList.remove('active');
      }else{
        activeTags.add(tag);
        b.classList.add('active');
      }

      if(activeTags.size===0){
        allBtn?.classList.add('active');
      }
    }

    await renderGallery();
  };
}
async function renderGallery(){
  const all=await getAllPhotos(),photos=all.filter(p=>[...activeTags].every(t=>(p.tags||[]).includes(t)));
  $('galleryEmpty').classList.toggle('hidden',photos.length>0);
  $('gallery').innerHTML=photos.map(p=>`<button class="photo-card" data-id="${p.id}"><img src="${p.image}"><div class="overlay">${new Date(p.createdAt).toLocaleDateString('it-IT')}<br>${(p.tags||[]).slice(0,3).map(esc).join(' · ')}</div></button>`).join('');
  document.querySelectorAll('.photo-card').forEach(c=>c.onclick=()=>openPhoto(Number(c.dataset.id),all))
}
function openPhoto(id,all){
  const p=all.find(x=>x.id===id);if(!p)return;
  $('modalImg').src=p.image;$('modalMeta').innerHTML=`<strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong><div class="muted">GPS ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} · ±${Math.round(p.accuracy||0)} m</div><div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>${p.aiSummary?`<div class="ai-summary"><b>AI</b> ${esc(p.aiSummary)}</div>`:''}<div class="muted">Drive: ${p.syncStatus==='synced'?'sincronizzata':'in attesa'} · AI: ${p.aiStatus==='classified'?'classificata':'fallback'}</div>`;
  $('modal').classList.remove('hidden')
}
function bindModal(){$('closeModal').onclick=()=>$('modal').classList.add('hidden');$('modal').onclick=e=>{if(e.target.id==='modal')$('modal').classList.add('hidden')}}

function bindSettings(){
  $('menuBtn').onclick=()=>openSettings();
  document.querySelectorAll('[data-close-drawer]').forEach(x=>x.onclick=()=>$('settingsPanel').classList.add('hidden'));
  $('saveSettingsBtn').onclick=async()=>{
    settings.googleClientId=$('clientIdInput').value.trim();
    settings.driveRootFolderId=$('driveRootInput').value.trim();
    settings.aiEndpoint=$('aiEndpointInput').value.trim();
    await saveSettings();$('settingsPanel').classList.add('hidden');updateIntegrationStatus()
  };
  $('driveConnectBtn').onclick=connectDrive;
  $('syncNowBtn').onclick=()=>syncPending(true);
  $('exportBtn').onclick=exportBackup;
  updateIntegrationStatus()
}
function openSettings(){
  $('clientIdInput').value=settings.googleClientId||'';$('driveRootInput').value=settings.driveRootFolderId||'';$('aiEndpointInput').value=settings.aiEndpoint||'';$('settingsPanel').classList.remove('hidden')
}
function updateIntegrationStatus(){
  $('aiDot').className=settings.aiEndpoint?'status-dot wait':'status-dot offline';
  $('aiStatus').textContent=settings.aiEndpoint?'Endpoint AI configurato':'AI non configurata · fallback locale';
}

function initTokenClient(){
  if(!window.google?.accounts?.oauth2)throw new Error('Google Identity Services non ancora disponibile');
  if(!settings.googleClientId)throw new Error('Google Client ID non configurato');
  googleTokenClient=google.accounts.oauth2.initTokenClient({
    client_id:settings.googleClientId,
    scope:'https://www.googleapis.com/auth/drive',
    callback:()=>{}
  })
}
async function connectDrive(){
  try{
    initTokenClient();
    const token=await new Promise((resolve,reject)=>{
      googleTokenClient.callback=r=>r.error?reject(r):resolve(r.access_token);
      googleTokenClient.requestAccessToken({prompt:'consent'})
    });
    googleAccessToken=token;$('driveDot').className='status-dot ok';$('driveText').textContent='Collegato';$('drivePanelText').textContent='Drive collegato. Le nuove foto possono essere sincronizzate.';
    await syncPending(true)
  }catch(err){
    $('driveDot').className='status-dot err';$('driveText').textContent='Errore';alert('Collegamento Drive non riuscito: '+(err.message||err))
  }
}
async function ensureToken(){
  if(googleAccessToken)return googleAccessToken;
  initTokenClient();
  googleAccessToken=await new Promise((resolve,reject)=>{
    googleTokenClient.callback=r=>r.error?reject(r):resolve(r.access_token);
    googleTokenClient.requestAccessToken({prompt:''})
  });
  return googleAccessToken
}

async function syncPending(showAlerts=false){
  const photos=await getAllPhotos();

  for(const p of photos){
    if(p.syncStatus==='syncing'){
      p.syncStatus='pending';
      p.syncError='';
      await putPhoto(p);
    }
  }

  const fresh=await getAllPhotos();
  const pending=fresh.filter(p=>p.syncStatus!=='synced');

  if(!pending.length){
    if(showAlerts) alert('Tutte le foto sono già sincronizzate.');
    return;
  }
  if(!settings.driveRootFolderId){
    if(showAlerts) alert('Configura prima la cartella Drive.');
    return;
  }

  let token;
  try{
    token=await ensureToken();
    const folder=await validateDriveFolder(token,settings.driveRootFolderId);
    $('drivePanelText').textContent=`Cartella pronta: ${folder.name}`;
  }catch(err){
    const msg=humanDriveError(err);
    $('driveDot').className='status-dot err';
    $('driveText').textContent='Drive non pronto';
    $('drivePanelText').textContent=msg;
    if(showAlerts) alert(msg);
    return;
  }

  $('driveDot').className='status-dot wait';
  $('driveText').textContent='Sincronizzo…';

  let done=0;
  const errors=[];

  for(const p of pending){
    try{
      p.syncStatus='syncing';
      p.syncError='';
      await putPhoto(p);
      await refreshUI();

      const folderId=await ensureDateFolder(token,p.createdAt);
      const uploaded=await uploadToDrive(token,p,folderId);

      p.syncStatus='synced';
      p.driveFileId=uploaded.id||'';
      p.driveWebViewLink=uploaded.webViewLink||'';
      p.syncedAt=Date.now();
      p.syncError='';
      await putPhoto(p);
      done++;
    }catch(err){
      p.syncStatus='error';
      p.syncError=humanDriveError(err);
      await putPhoto(p);
      errors.push(`#${p.id}: ${p.syncError}`);
    }
  }

  await refreshUI();

  if(done===pending.length){
    $('driveDot').className='status-dot ok';
    $('driveText').textContent=`${done} sincronizzate`;
    $('drivePanelText').textContent='Drive collegato e sincronizzazione completata.';
  }else{
    $('driveDot').className='status-dot err';
    $('driveText').textContent=`${done}/${pending.length}`;
    $('drivePanelText').textContent=errors[0]||'Errore di sincronizzazione.';
  }

  if(showAlerts){
    if(errors.length) alert(`Sincronizzazione: ${done}/${pending.length}\n\n${errors.join('\n\n')}`);
    else alert(`Sincronizzazione completata: ${done}/${pending.length}`);
  }
}

async function validateDriveFolder(token,folderId){
  const fields=encodeURIComponent('id,name,mimeType,trashed,capabilities(canAddChildren,canListChildren)');
  const res=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=${fields}`);
  const folder=await res.json();
  if(folder.trashed) throw new Error('FOLDER_TRASHED|La cartella Drive configurata è nel cestino.');
  if(folder.mimeType!=='application/vnd.google-apps.folder') throw new Error('NOT_FOLDER|L’ID configurato non appartiene a una cartella Drive.');
  if(folder.capabilities && folder.capabilities.canAddChildren===false) throw new Error('NO_WRITE|L’account Google collegato non può aggiungere file in questa cartella.');
  return folder;
}

function humanDriveError(err){
  const raw=String(err?.message||err||'Errore sconosciuto');
  if(raw.includes('FOLDER_TRASHED|')) return raw.split('|')[1];
  if(raw.includes('NOT_FOLDER|')) return raw.split('|')[1];
  if(raw.includes('NO_WRITE|')) return raw.split('|')[1];
  if(raw.includes('Drive HTTP 404')) return 'Cartella Drive non trovata. Controlla l’ID e l’account Google collegato.';
  if(raw.includes('Drive HTTP 403')) return 'Google Drive ha negato l’accesso alla cartella. Premi “Collega Drive” e autorizza di nuovo FM foto.';
  if(raw.includes('Drive HTTP 401')) return 'Autorizzazione Google scaduta o non valida. Premi “Collega Drive” e accedi di nuovo.';
  if(raw.includes('insufficientPermissions') || raw.includes('insufficient_scope')) return 'Il permesso Google precedente non è sufficiente. Ricollega Drive e autorizza il nuovo permesso.';
  return raw;
}

async function driveRequest(token,url,options={}){
  const res=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`}});
  if(!res.ok){
    const body=await res.text();
    let detail=body;
    try{
      const j=JSON.parse(body);
      detail=j?.error?.message || j?.error?.errors?.[0]?.reason || body;
    }catch(_){}
    throw new Error(`Drive HTTP ${res.status}: ${detail}`);
  }
  return res;
}
async function ensureDateFolder(token,ts){
  const d=new Date(ts),year=String(d.getFullYear()),month=String(d.getMonth()+1).padStart(2,'0');
  const fm=await ensureFolder(token,'FM_FOTO',settings.driveRootFolderId);
  const y=await ensureFolder(token,year,fm);
  return ensureFolder(token,month,y)
}
async function ensureFolder(token,name,parentId){
  const q=encodeURIComponent(`name='${name.replaceAll("'","\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  let r=await driveRequest(token,`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
  let j=await r.json();if(j.files?.[0])return j.files[0].id;
  r=await driveRequest(token,'https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]})});
  return (await r.json()).id
}
async function uploadToDrive(token,p,folderId){
  const blob=dataUrlToBlob(p.image),date=new Date(p.createdAt);
  const name=`FMFOTO_${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}${String(date.getSeconds()).padStart(2,'0')}_${p.id}.jpg`;
  const meta={name,parents:[folderId],description:`FM foto | GPS ${p.lat}, ${p.lng} | ${new Date(p.createdAt).toISOString()} | tags: ${(p.tags||[]).join(', ')}`,appProperties:{fmfoto:'1',lat:String(p.lat),lng:String(p.lng),capturedAt:String(p.createdAt),tags:(p.tags||[]).join('|')}};
  const boundary='fmfoto_'+Math.random().toString(36).slice(2);
  const head=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail=`\r\n--${boundary}--`;
  const body=new Blob([head,blob,tail],{type:`multipart/related; boundary=${boundary}`});
  const r=await driveRequest(token,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  return r.json()
}
function dataUrlToBlob(dataUrl){const [h,b]=dataUrl.split(','),mime=h.match(/:(.*?);/)[1],bin=atob(b),arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return new Blob([arr],{type:mime})}

function renderQueue(photos){
  const q=photos.filter(p=>p.syncStatus!=='synced').slice(0,20);
  $('queueList').innerHTML=q.length?q.map(p=>`<div class="queue-item"><img class="queue-thumb" src="${p.image}"><div class="queue-info"><b>${new Date(p.createdAt).toLocaleString('it-IT')}</b><small>${(p.tags||[]).slice(0,4).map(esc).join(' · ')}</small>${p.syncError?`<small style="color:#c62828;margin-top:4px">${esc(p.syncError)}</small>`:''}</div><span class="queue-status">${p.syncStatus==='error'?'ERRORE':p.syncStatus==='syncing'?'SYNC…':'IN CODA'}</span></div>`).join(''):`<div class="muted">Nessuna foto in coda.</div>`
}

async function exportBackup(){
  const photos=await getAllPhotos();
  const payload={format:'FM_FOTO_BACKUP',version:2,exportedAt:new Date().toISOString(),photos};
  const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`FM_FOTO_backup_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)
}

function registerServiceWorker(){if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js?v=2.0.0').catch(console.warn)}
function $(id){return document.getElementById(id)}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
