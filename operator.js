const DB_NAME='famaferFotoCantiere';
const DB_VERSION=6;
const STORE='photos';
const SETTINGS_STORE='settings';
let db,currentPosition=null,settings={},googleTokenClient=null,googleAccessToken=null,isBusy=false;

const tagsVoc=['ringhiera','scala','soppalco','tettoia','pensilina','parapetto','carpenteria','carpenteria strutturale','capannone','cancello','recinzione','grigliato','passerella','trave','pilastro','piastre','bulloni','gradini','acciaio','inox','alluminio','zincato','verniciato','grezzo','interno','esterno','montaggio','installato','completato','dettaglio','copertura','facciata','struttura','manufatto metallico'];

document.addEventListener('DOMContentLoaded',init);

async function init(){
  db=await openDB();
  settings=await loadSettings();
  $('cameraInput').addEventListener('change',handlePhoto);
  await updateCount();
  updateNetworkState();
  window.addEventListener('online',()=>{updateNetworkState();syncPending()});
  window.addEventListener('offline',updateNetworkState);
  requestLocation();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js?v=6.0.0').catch(()=>{});
  if(navigator.onLine)setTimeout(syncPending,1800);
}

function openDB(){return new Promise((res,rej)=>{
  const r=indexedDB.open(DB_NAME,DB_VERSION);
  r.onupgradeneeded=e=>{
    const d=e.target.result;
    let s=d.objectStoreNames.contains(STORE)?e.target.transaction.objectStore(STORE):d.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
    if(!s.indexNames.contains('createdAt'))s.createIndex('createdAt','createdAt');
    if(!s.indexNames.contains('syncStatus'))s.createIndex('syncStatus','syncStatus');
    if(!d.objectStoreNames.contains(SETTINGS_STORE))d.createObjectStore(SETTINGS_STORE,{keyPath:'key'});
  };
  r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);
})}
function reqp(r){return new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function st(n,m='readonly'){return db.transaction(n,m).objectStore(n)}
function addPhoto(v){return reqp(st(STORE,'readwrite').add(v))}
function putPhoto(v){return reqp(st(STORE,'readwrite').put(v))}
function getAllPhotos(){return reqp(st(STORE).getAll()).then(a=>a.sort((x,y)=>y.createdAt-x.createdAt))}
async function loadSettings(){
  const saved=await reqp(st(SETTINGS_STORE).get('config')).catch(()=>null);
  return Object.assign({},window.FM_FOTO_DEFAULTS||{},saved?.value||{});
}

function requestLocation(){
  setState('wait','Acquisizione GPS…');disableCapture(true);
  navigator.geolocation.getCurrentPosition(pos=>{
    currentPosition={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy};
    setState('ok','Pronto');
    $('readyTitle').textContent='Pronto allo scatto';
    $('readySub').textContent=`Posizione acquisita · ±${Math.round(pos.coords.accuracy)} m`;
    disableCapture(false);
  },()=>{
    setState('err','GPS necessario');
    $('readyTitle').textContent='Posizione necessaria';
    $('readySub').textContent='Consenti la posizione per usare FM foto.';
  },{enableHighAccuracy:true,timeout:15000,maximumAge:15000});
}

async function handlePhoto(e){
  const file=e.target.files?.[0];if(!file||isBusy)return;
  if(!currentPosition){e.target.value='';requestLocation();return}
  isBusy=true;disableCapture(true);showWorking('Elaborazione foto…','Classificazione AI e salvataggio automatico.');
  try{
    const image=await compress(file,1600,.78);
    let ai=null,aiStatus='fallback',tags=['da classificare'];
    if(navigator.onLine&&settings.aiEndpoint){
      try{ai=await classifyAI(image);if(ai?.tags?.length){tags=norm(ai.tags);aiStatus='classified'}}catch(err){console.warn(err)}
    }
    const rec={image,createdAt:Date.now(),lat:currentPosition.lat,lng:currentPosition.lng,accuracy:currentPosition.accuracy,tags,aiStatus,aiConfidence:ai?.confidence??null,aiSummary:ai?.summary||'',syncStatus:'pending',schemaVersion:6,appVersion:'6.0.0'};
    const id=await addPhoto(rec);rec.id=id;await updateCount();
    if(navigator.onLine){showWorking('Foto salvata','Sincronizzazione automatica…');await syncPending()}
    hideWorking();showSuccess(aiStatus==='classified'?'Foto salvata, classificata e inviata automaticamente.':'Foto salvata. Il sistema completerà automaticamente le operazioni mancanti.');
  }catch(err){console.error(err);hideWorking();showSuccess('Foto conservata sul dispositivo. Il sistema riproverà automaticamente.')}
  finally{e.target.value='';isBusy=false;disableCapture(false);setTimeout(()=>$('successCard').classList.add('hidden'),5000)}
}

function compress(file,maxSide,q){return new Promise((res,rej)=>{
  const r=new FileReader();r.onload=()=>{const img=new Image();img.onload=()=>{
    let w=img.width,h=img.height;if(Math.max(w,h)>maxSide){const s=maxSide/Math.max(w,h);w=Math.round(w*s);h=Math.round(h*s)}
    const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);res(c.toDataURL('image/jpeg',q))
  };img.onerror=rej;img.src=r.result};r.onerror=rej;r.readAsDataURL(file)
})}

async function classifyAI(image){
  const r=await fetch(settings.aiEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,allowedTags:tagsVoc})});
  if(!r.ok)throw new Error(`AI ${r.status}: ${await r.text()}`);return r.json()
}
function norm(a){return [...new Set(a.map(x=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,8)}
async function updateCount(){$('photoCount').textContent=(await getAllPhotos()).length}

function initToken(){
  if(!window.google?.accounts?.oauth2)throw new Error('Google non pronto');
  googleTokenClient=google.accounts.oauth2.initTokenClient({client_id:settings.googleClientId,scope:'https://www.googleapis.com/auth/drive',callback:()=>{}})
}
async function ensureToken(){
  if(googleAccessToken)return googleAccessToken;
  initToken();
  googleAccessToken=await new Promise((res,rej)=>{googleTokenClient.callback=r=>r.error?rej(r):res(r.access_token);googleTokenClient.requestAccessToken({prompt:''})});
  return googleAccessToken
}
async function syncPending(){
  if(!navigator.onLine||!settings.driveRootFolderId)return;
  const all=await getAllPhotos();
  for(const p of all)if(p.syncStatus==='syncing'){p.syncStatus='pending';await putPhoto(p)}
  const pending=(await getAllPhotos()).filter(p=>p.syncStatus!=='synced');if(!pending.length)return;
  let token;try{token=await ensureToken();await validateFolder(token,settings.driveRootFolderId)}catch(err){console.warn('Drive auth',err);return}
  for(const p of pending){
    try{
      p.syncStatus='syncing';await putPhoto(p);
      const folderId=await ensureDateFolder(token,p.createdAt);
      const up=await upload(token,p,folderId);
      p.syncStatus='synced';p.driveFileId=up.id||'';p.syncedAt=Date.now();p.syncError='';await putPhoto(p)
    }catch(err){p.syncStatus='error';p.syncError=String(err?.message||err);await putPhoto(p)}
  }
}
async function validateFolder(t,id){const r=await dreq(t,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed`);const f=await r.json();if(f.trashed||f.mimeType!=='application/vnd.google-apps.folder')throw new Error('Cartella non valida')}
async function dreq(t,u,o={}){const r=await fetch(u,{...o,headers:{...(o.headers||{}),Authorization:`Bearer ${t}`}});if(!r.ok)throw new Error(`Drive ${r.status}: ${await r.text()}`);return r}
async function ensureDateFolder(t,ts){const d=new Date(ts);const fm=await ensureFolder(t,'FM_FOTO',settings.driveRootFolderId);const y=await ensureFolder(t,String(d.getFullYear()),fm);return ensureFolder(t,String(d.getMonth()+1).padStart(2,'0'),y)}
async function ensureFolder(t,name,parent){const q=encodeURIComponent(`name='${name}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);let r=await dreq(t,`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);let j=await r.json();if(j.files?.[0])return j.files[0].id;r=await dreq(t,'https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parent]})});return (await r.json()).id}
async function upload(t,p,folderId){
  const blob=toBlob(p.image),d=new Date(p.createdAt),name=`FMFOTO_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}_${p.id}.jpg`;
  const meta={name,parents:[folderId],description:`FM foto | GPS ${p.lat}, ${p.lng} | tags: ${(p.tags||[]).join(', ')}`,appProperties:{fmfoto:'1',lat:String(p.lat),lng:String(p.lng),tags:(p.tags||[]).join('|')}};
  const b='fmfoto_'+Math.random().toString(36).slice(2),head=`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: image/jpeg\r\n\r\n`,tail=`\r\n--${b}--`;
  const r=await dreq(t,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${b}`},body:new Blob([head,blob,tail],{type:`multipart/related; boundary=${b}`})});return r.json()
}
function toBlob(u){const [h,b]=u.split(','),m=h.match(/:(.*?);/)[1],bin=atob(b),a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type:m})}

function updateNetworkState(){$('offlineCard').classList.toggle('hidden',navigator.onLine)}
function showWorking(t,s){$('workingTitle').textContent=t;$('workingSub').textContent=s;$('workingCard').classList.remove('hidden');$('successCard').classList.add('hidden')}
function hideWorking(){$('workingCard').classList.add('hidden')}
function showSuccess(t){$('successText').textContent=t;$('successCard').classList.remove('hidden')}
function disableCapture(v){$('cameraInput').disabled=v;$('captureLabel').classList.toggle('disabled',v)}
function setState(s,t){$('globalDot').className=`status-dot ${s}`;$('globalText').textContent=t}
function $(id){return document.getElementById(id)}
