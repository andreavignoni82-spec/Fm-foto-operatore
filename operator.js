const DB_NAME='famaferFotoCantiere';
const DB_VERSION=11;
const STORE='photos';
const SETTINGS_STORE='settings';
const APP_VERSION='7.5.0';

let db=null;
let currentPosition=null;
let settings={};
let isBusy=false;

const tagsVoc=[
 'ringhiera','scala','soppalco','tettoia','pensilina','parapetto',
 'carpenteria','carpenteria strutturale','capannone','cancello','recinzione',
 'grigliato','passerella','trave','pilastro','piastre','bulloni','gradini',
 'acciaio','inox','alluminio','zincato','verniciato','grezzo',
 'interno','esterno','montaggio','installato','completato','dettaglio',
 'copertura','facciata','struttura','manufatto metallico'
];

document.addEventListener('DOMContentLoaded',init);

async function init(){
  db=await openDB();
  settings=await loadSettings();

  $('cameraInput').addEventListener('change',handlePhoto);
  bindNavigation();
  bindModal();
  renderTagFilters();

  await updateCount();
  updateNetworkState();

  setState('ok','Pronto');
  $('readyTitle').textContent='Pronto allo scatto';
  $('readySub').textContent='Premi SCATTA FOTO. Dopo lo scatto verrà acquisita automaticamente la posizione.';

  window.addEventListener('online',async()=>{
    updateNetworkState();
    await retryPending();
  });
  window.addEventListener('offline',updateNetworkState);

  // Tentativo silenzioso, ma non blocca mai il pulsante fotocamera.
  warmLocation();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js?v=7.5.0').catch(()=>{});
  }

  if(navigator.onLine){
    setTimeout(retryPending,1500);
  }
}
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);

    req.onupgradeneeded=e=>{
      const d=e.target.result;
      let s;

      if(!d.objectStoreNames.contains(STORE)){
        s=d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
      }else{
        s=e.target.transaction.objectStore(STORE);
      }

      if(!s.indexNames.contains('createdAt'))s.createIndex('createdAt','createdAt');
      if(!s.indexNames.contains('syncStatus'))s.createIndex('syncStatus','syncStatus');

      if(!d.objectStoreNames.contains(SETTINGS_STORE)){
        d.createObjectStore(SETTINGS_STORE,{keyPath:'key'});
      }
      // Migrazione solo incrementale: nessuna cancellazione delle fotografie.
    };

    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

function reqPromise(req){
  return new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function store(name,mode='readonly'){
  return db.transaction(name,mode).objectStore(name);
}
function addPhoto(v){return reqPromise(store(STORE,'readwrite').add(v))}
function putPhoto(v){return reqPromise(store(STORE,'readwrite').put(v))}
function getAllPhotos(){
  return reqPromise(store(STORE).getAll())
    .then(a=>a.sort((x,y)=>y.createdAt-x.createdAt));
}


async function fetchSharedArchive(force=false){
  const now=Date.now();
  if(!force && sharedArchiveCache.length && (now-sharedArchiveFetchedAt)<30000) return sharedArchiveCache;
  if(!navigator.onLine || !settings.backendEndpoint) return sharedArchiveCache;

  const res=await fetch(settings.backendEndpoint.replace(/\/$/,'')+'/archive');
  const text=await res.text();
  let data;
  try{data=JSON.parse(text)}catch{throw new Error(`Archivio backend ${res.status}: ${text.slice(0,200)}`)}
  if(!res.ok||!data.ok) throw new Error(data.message||data.error||`Archivio backend ${res.status}`);

  sharedArchiveCache=(data.photos||[]).map(p=>({
    id:`remote:${p.driveFileId}`,
    driveFileId:p.driveFileId,
    image:p.photoUrl,
    createdAt:Number(p.capturedAt)||Date.parse(p.createdTime)||0,
    lat:Number(p.lat), lng:Number(p.lng), accuracy:Number(p.accuracy)||0,
    tags:Array.isArray(p.tags)?p.tags:[],
    manualTags:Array.isArray(p.manualTags)?p.manualTags:[],
    aiSummary:p.summary||'',
    aiStatus:'classified', syncStatus:'synced', backendStatus:'completed', remote:true
  })).sort((a,b)=>b.createdAt-a.createdAt);

  sharedArchiveFetchedAt=now;
  return sharedArchiveCache;
}

async function getUnifiedPhotos(forceRemote=false){
  const local=await getAllPhotos();
  let remote=[];
  try{remote=await fetchSharedArchive(forceRemote)}catch(err){console.warn('Archivio condiviso non disponibile',err)}
  const remoteIds=new Set(remote.map(p=>p.driveFileId).filter(Boolean));
  const localOnly=local.filter(p=>!p.driveFileId || !remoteIds.has(p.driveFileId));
  return [...remote,...localOnly].sort((a,b)=>b.createdAt-a.createdAt);
}

async function loadSettings(){
  // TEST 07: l'operatore conosce soltanto l'endpoint backend.
  return Object.assign({},window.FM_FOTO_DEFAULTS||{});
}

function warmLocation(){
  if(!navigator.geolocation)return;
  navigator.geolocation.getCurrentPosition(
    pos=>savePosition(pos),
    ()=>{},
    {enableHighAccuracy:true,timeout:5000,maximumAge:30000}
  );
}

function savePosition(pos){
  currentPosition={
    lat:pos.coords.latitude,
    lng:pos.coords.longitude,
    accuracy:pos.coords.accuracy,
    capturedAt:Date.now()
  };
  setState('ok','Pronto');
}

function acquireLocation(){
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation){
      reject(new Error('GPS non supportato dal browser'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos=>{
        savePosition(pos);
        resolve(currentPosition);
      },
      err=>{
        let message='Impossibile acquisire la posizione.';
        if(err?.code===1)message='Consenti la posizione a questo sito.';
        if(err?.code===2)message='Posizione temporaneamente non disponibile.';
        if(err?.code===3)message='Tempo scaduto durante la ricerca della posizione.';
        reject(new Error(message));
      },
      {enableHighAccuracy:true,timeout:15000,maximumAge:10000}
    );
  });
}

function requestLocation(){return acquireLocation()}

async function handlePhoto(e){
  const file=e.target.files?.[0];
  if(!file||isBusy)return;

  isBusy=true;
  showWorking('Elaborazione foto…','Acquisizione posizione e salvataggio automatico.');

  let rec=null;

  try{
    // Safari ha già aperto la fotocamera tramite il label.
    // Ora possiamo acquisire il GPS senza perdere l'azione fotocamera.
    try{
      await acquireLocation();
    }catch(gpsErr){
      hideWorking();
      showSuccess(String(gpsErr?.message||gpsErr));
      e.target.value='';
      isBusy=false;
      return;
    }

    const image=await compress(file,1600,.78);

    rec={
      image,
      createdAt:Date.now(),
      lat:currentPosition.lat,
      lng:currentPosition.lng,
      accuracy:currentPosition.accuracy,
      tags:['da classificare'],
      manualTags:[],
      aiStatus:'pending',
      aiConfidence:null,
      aiSummary:'',
      syncStatus:'pending',
      backendStatus:'pending',
      driveFileId:'',
      schemaVersion:9,
      appVersion:APP_VERSION
    };

    rec.id=await addPhoto(rec);
    await updateCount();

    if(navigator.onLine){
      showWorking('Foto salvata','AI e Drive automatici…');

      const result=await sendToBackend(rec);

      const aiTags=normalizeTags(result.tags||[]);
      rec.tags=normalizeTags([...(aiTags||[]),...(rec.manualTags||[])]);
      rec.aiStatus='classified';
      rec.aiConfidence=Number.isFinite(Number(result.confidence))?Number(result.confidence):null;
      rec.aiSummary=String(result.summary||'').slice(0,280);
      rec.syncStatus=result.driveUploaded?'synced':'pending';
      rec.backendStatus='completed';
      rec.driveFileId=result.driveFileId||'';
      rec.syncedAt=result.driveUploaded?Date.now():null;
      rec.lastError='';
      await putPhoto(rec);
      sharedArchiveFetchedAt=0;

      hideWorking();
      showSuccess('Foto classificata e archiviata automaticamente.');
    }else{
      hideWorking();
      showSuccess('Foto salvata. Verrà elaborata appena torna la connessione.');
    }

    // Aggiorna eventuali viste aperte
    await renderArchive();
    if(document.getElementById('tagsView').classList.contains('active'))await renderTagGallery();
    if(document.getElementById('mapView').classList.contains('active'))await renderMap();

  }catch(err){
    console.warn('FM foto backend:',err);

    if(rec){
      rec.backendStatus='error';
      rec.syncStatus='pending';
      rec.lastError=String(err?.message||err);
      await putPhoto(rec).catch(()=>{});
    }

    hideWorking();
    showSuccess('Foto salvata sul dispositivo. Il sistema riproverà automaticamente.');
  }finally{
    e.target.value='';
    isBusy=false;
    setTimeout(()=>$('successCard').classList.add('hidden'),5000);
  }
}
async function retryPending(){
  if(!navigator.onLine||!settings.backendEndpoint)return;

  const photos=await getAllPhotos();
  const pending=photos.filter(p=>p.backendStatus!=='completed'||p.syncStatus!=='synced');

  for(const rec of pending){
    try{
      const result=await sendToBackend(rec);

      const aiTags=normalizeTags(result.tags||rec.tags||[]);
      rec.tags=normalizeTags([...(aiTags||[]),...(rec.manualTags||[])]);
      rec.aiStatus='classified';
      rec.aiConfidence=Number.isFinite(Number(result.confidence))?Number(result.confidence):rec.aiConfidence;
      rec.aiSummary=String(result.summary||rec.aiSummary||'').slice(0,280);
      rec.backendStatus='completed';
      rec.syncStatus=result.driveUploaded?'synced':'pending';
      rec.driveFileId=result.driveFileId||rec.driveFileId||'';
      rec.syncedAt=result.driveUploaded?Date.now():rec.syncedAt;
      rec.lastError='';
      await putPhoto(rec);
      sharedArchiveFetchedAt=0;
    }catch(err){
      rec.backendStatus='error';
      rec.lastError=String(err?.message||err);
      await putPhoto(rec).catch(()=>{});
    }
  }
}

async function sendToBackend(rec){
  if(!settings.backendEndpoint){
    throw new Error('Backend non configurato');
  }

  const res=await fetch(
    settings.backendEndpoint.replace(/\/$/,'')+'/process',
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        localId:String(rec.id),
        image:rec.image,
        capturedAt:rec.createdAt,
        lat:rec.lat,
        lng:rec.lng,
        accuracy:rec.accuracy,
        allowedTags:tagsVoc,
        manualTags:rec.manualTags||[]
      })
    }
  );

  const text=await res.text();

  let data;
  try{
    data=JSON.parse(text);
  }catch{
    throw new Error(`Backend ${res.status}: ${text.slice(0,200)}`);
  }

  if(!res.ok){
    throw new Error(data.message||data.error||`Backend ${res.status}`);
  }

  if(!data.ok){
    throw new Error(data.message||'Backend non completato');
  }

  return data;
}

function compress(file,maxSide,quality){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();

    r.onload=()=>{
      const img=new Image();

      img.onload=()=>{
        let w=img.width,h=img.height;

        if(Math.max(w,h)>maxSide){
          const scale=maxSide/Math.max(w,h);
          w=Math.round(w*scale);
          h=Math.round(h*scale);
        }

        const c=document.createElement('canvas');
        c.width=w;c.height=h;
        c.getContext('2d').drawImage(img,0,0,w,h);

        resolve(c.toDataURL('image/jpeg',quality));
      };

      img.onerror=reject;
      img.src=r.result;
    };

    r.onerror=reject;
    r.readAsDataURL(file);
  });
}

function normalizeTags(a){
  return [...new Set(
    (a||[])
      .map(x=>String(x).trim().toLowerCase())
      .filter(Boolean)
  )].slice(0,8);
}

async function updateCount(){
  $('photoCount').textContent=(await getAllPhotos()).length;
}

function updateNetworkState(){
  $('offlineCard').classList.toggle('hidden',navigator.onLine);
}

function showWorking(title,sub){
  $('workingTitle').textContent=title;
  $('workingSub').textContent=sub;
  $('workingCard').classList.remove('hidden');
  $('successCard').classList.add('hidden');
}
function hideWorking(){
  $('workingCard').classList.add('hidden');
}
function showSuccess(text){
  $('successText').textContent=text;
  $('successCard').classList.remove('hidden');
}
function setState(state,text){
  $('globalDot').className=`status-dot ${state}`;
  $('globalText').textContent=text;
}

let currentModalPhotoId=null;
let sharedArchiveCache=[];
let sharedArchiveFetchedAt=0;
let map=null,markersLayer=null;
let activeTags=new Set();
let mapTags=new Set();

function bindNavigation(){
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.operator-view').forEach(x=>x.classList.remove('active'));
      $(btn.dataset.view).classList.add('active');

      if(btn.dataset.view==='mapView')await renderMap();
      if(btn.dataset.view==='tagsView')await renderTagGallery();
      if(btn.dataset.view==='archiveView')await renderArchive();
    });
  });
}

async function renderArchive(){
  const photos=await getUnifiedPhotos(true);
  const host=$('archiveGallery');
  if(!host)return;
  $('archiveEmpty').classList.toggle('hidden',photos.length>0);
  host.innerHTML=photos.map(photoCardHTML).join('');
  bindPhotoCards(host,photos);
}


function renderTagFilters(){
  const host=$('tagFilters');
  if(!host)return;
  host.innerHTML=`<button class="filter-chip active" data-tag="">Tutte</button>`+
    tagsVoc.map(t=>`<button class="filter-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');

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
      if(activeTags.has(tag)){activeTags.delete(tag);b.classList.remove('active')}
      else{activeTags.add(tag);b.classList.add('active')}
      if(activeTags.size===0)allBtn?.classList.add('active');
    }
    await renderTagGallery();
  };
}

async function renderTagGallery(){
  const all=await getUnifiedPhotos();
  const photos=all.filter(p=>[...activeTags].every(t=>(p.tags||[]).includes(t)));
  $('tagEmpty').classList.toggle('hidden',photos.length>0);
  $('tagGallery').innerHTML=photos.map(photoCardHTML).join('');
  bindPhotoCards($('tagGallery'),all);
}


function photoCardHTML(p){
  return `<button class="photo-card" data-id="${escapeHtml(p.id)}">
    <img src="${p.image}" alt="Foto cantiere">
    <div class="overlay">${new Date(p.createdAt).toLocaleDateString('it-IT')}<br>${(p.tags||[]).slice(0,3).map(escapeHtml).join(' · ')}</div>
  </button>`;
}

function bindPhotoCards(host,all){
  host.querySelectorAll('.photo-card').forEach(card=>{
    card.onclick=()=>openPhoto(card.dataset.id,all);
  });
}

function openPhoto(id,all){
  const p=all.find(x=>String(x.id)===String(id));
  if(!p)return;

  currentModalPhotoId=String(id);

  $('modalImg').src=p.image;
  $('modalMeta').innerHTML=`
    <strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong>
    <div class="muted">GPS ${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)} · ±${Math.round(p.accuracy||0)} m</div>
    <div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    ${p.aiSummary?`<div class="ai-summary">${escapeHtml(p.aiSummary)}</div>`:''}`;

  renderManualTagEditor(p);
  $('photoModal').classList.remove('hidden');
}

function renderManualTagEditor(photo){
  const quick=['ringhiera','scala','soppalco','tettoia','parapetto','cancello','recinzione','passerella','grigliato','zincato','verniciato','installato'];

  $('manualTagQuick').innerHTML=quick.map(t=>{
    const active=(photo.manualTags||[]).includes(t);
    return `<button class="filter-chip ${active?'active':''}" data-quick-manual="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }).join('');

  $('manualTagList').innerHTML=(photo.manualTags||[]).map(t=>
    `<span class="manual-tag-chip">${escapeHtml(t)} <button type="button" data-remove-manual="${escapeHtml(t)}">×</button></span>`
  ).join('');

  $('manualTagQuick').onclick=async e=>{
    const b=e.target.closest('[data-quick-manual]');
    if(!b)return;
    await toggleManualTag(photo.id,b.dataset.quickManual);
  };

  $('manualTagList').onclick=async e=>{
    const b=e.target.closest('[data-remove-manual]');
    if(!b)return;
    await removeManualTag(photo.id,b.dataset.removeManual);
  };
}

async function toggleManualTag(photoId,tag){
  const p=await resolvePhoto(photoId); if(!p)return;
  p.manualTags=Array.isArray(p.manualTags)?p.manualTags:[];
  if(p.manualTags.includes(tag)) p.manualTags=p.manualTags.filter(x=>x!==tag);
  else p.manualTags=normalizeTags([...p.manualTags,tag]);
  p.tags=mergeDisplayTags(p.tags,p.manualTags);
  await persistManualTags(p);
  renderManualTagEditor(p); refreshModalMeta(p); await refreshVisibleViews();
}


async function addCustomManualTag(){
  const raw=$('manualTagInput').value.trim().toLowerCase();
  if(!raw||currentModalPhotoId==null)return;
  const clean=raw.replace(/\s+/g,' ').slice(0,30);
  const p=await resolvePhoto(currentModalPhotoId); if(!p)return;
  p.manualTags=normalizeTags([...(p.manualTags||[]),clean]);
  p.tags=mergeDisplayTags(p.tags,p.manualTags);
  await persistManualTags(p);
  $('manualTagInput').value='';
  renderManualTagEditor(p); refreshModalMeta(p); await refreshVisibleViews();
}


async function removeManualTag(photoId,tag){
  const p=await resolvePhoto(photoId); if(!p)return;
  p.manualTags=(p.manualTags||[]).filter(x=>x!==tag);
  p.tags=(p.tags||[]).filter(x=>x!==tag);
  await persistManualTags(p);
  renderManualTagEditor(p); refreshModalMeta(p); await refreshVisibleViews();
}

async function resolvePhoto(photoId){
  const all=await getUnifiedPhotos();
  return all.find(x=>String(x.id)===String(photoId))||null;
}
function mergeDisplayTags(tags,manualTags){
  return normalizeTags([...(tags||[]),...(manualTags||[])]);
}
async function persistManualTags(photo){
  if(photo.remote || photo.driveFileId){
    if(!navigator.onLine)throw new Error('Connessione necessaria per modificare un tag condiviso.');
    if(!photo.driveFileId)throw new Error('File Drive non disponibile.');
    const res=await fetch(settings.backendEndpoint.replace(/\/$/,'')+'/update-tags',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({driveFileId:photo.driveFileId,manualTags:photo.manualTags||[]})
    });
    const text=await res.text(); let data;
    try{data=JSON.parse(text)}catch{throw new Error(text.slice(0,200))}
    if(!res.ok||!data.ok)throw new Error(data.message||data.error||'Aggiornamento tag fallito');
    photo.tags=data.tags||photo.tags; photo.manualTags=data.manualTags||photo.manualTags;
    sharedArchiveFetchedAt=0; await fetchSharedArchive(true);
  }else{
    const local=await getAllPhotos();
    const rec=local.find(x=>String(x.id)===String(photo.id));
    if(rec){
      rec.manualTags=photo.manualTags||[]; rec.tags=photo.tags||[];
      rec.backendStatus='pending'; rec.syncStatus='pending'; await putPhoto(rec);
    }
  }
}
function refreshModalMeta(p){
  $('modalMeta').innerHTML=`
    <strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong>
    <div class="muted">GPS ${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)} · ±${Math.round(p.accuracy||0)} m</div>
    <div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    ${p.aiSummary?`<div class="ai-summary">${escapeHtml(p.aiSummary)}</div>`:''}`;
}


async function refreshVisibleViews(){
  await updateCount();
  if($('archiveView').classList.contains('active'))await renderArchive();
  if($('tagsView').classList.contains('active'))await renderTagGallery();
  if($('mapView').classList.contains('active'))await renderMap();
}

function bindModal(){
  $('closePhotoModal').onclick=()=>{$('photoModal').classList.add('hidden');currentModalPhotoId=null};
  $('photoModal').onclick=e=>{if(e.target.id==='photoModal'){$('photoModal').classList.add('hidden');currentModalPhotoId=null}};
  $('addManualTagBtn').onclick=addCustomManualTag;
  $('manualTagInput').addEventListener('keydown',e=>{if(e.key==='Enter')addCustomManualTag()});
}

async function renderMap(){
  const all=(await getUnifiedPhotos()).filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng)));
  const photos=all.filter(p=>[...mapTags].every(t=>(p.tags||[]).includes(t)));
  $('mapEmpty').classList.toggle('hidden',photos.length>0);
  renderMapFilterBar(all);

  if(!map){
    map=L.map('map').setView([45.55,10.2],8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
    markersLayer=L.layerGroup().addTo(map);
  }
  setTimeout(()=>map.invalidateSize(),100); markersLayer.clearLayers();

  const groups=groupNearby(photos,25),bounds=[];
  groups.forEach(g=>{
    const lat=g.reduce((s,p)=>s+Number(p.lat),0)/g.length;
    const lng=g.reduce((s,p)=>s+Number(p.lng),0)/g.length;
    bounds.push([lat,lng]);
    const first=g[0],tags=[...new Set(g.flatMap(p=>p.tags||[]))].slice(0,8);
    L.marker([lat,lng]).addTo(markersLayer).bindPopup(
      `<strong>${g.length} foto</strong><br>${tags.map(escapeHtml).join(' · ')}<br>`+
      `<img src="${first.image}" style="width:180px;border-radius:8px;margin-top:8px">`
    );
  });
  if(bounds.length===1)map.setView(bounds[0],16);
  else if(bounds.length>1)map.fitBounds(bounds,{padding:[25,25]});
}


function renderMapFilterBar(allPhotos=[]){
  const host=$('mapTagBar');
  const allTags=[...new Set(
    allPhotos.flatMap(p=>p.tags||[]).map(t=>String(t).trim().toLowerCase()).filter(Boolean)
  )].sort((a,b)=>a.localeCompare(b,'it'));

  host.innerHTML=`<button class="filter-chip ${mapTags.size===0?'active':''}" data-map-tag="">Tutte</button>`+
    allTags.map(t=>`<button class="filter-chip ${mapTags.has(t)?'active':''}" data-map-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');

  host.onclick=async ev=>{
    const b=ev.target.closest('[data-map-tag]'); if(!b)return;
    const tag=b.dataset.mapTag;
    if(!tag)mapTags.clear(); else if(mapTags.has(tag))mapTags.delete(tag); else mapTags.add(tag);
    await renderMap();
  };
}


function groupNearby(photos,maxMeters){
  const groups=[];
  for(const p of photos){
    let group=groups.find(g=>distanceMeters(Number(p.lat),Number(p.lng),Number(g[0].lat),Number(g[0].lng))<=maxMeters);
    if(group)group.push(p);else groups.push([p]);
  }
  return groups;
}

function distanceMeters(lat1,lon1,lat2,lon2){
  const R=6371000,toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function escapeHtml(v){
  return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function $(id){
  return document.getElementById(id);
}
