const DB_NAME='famaferFotoCantiere';
const DB_VERSION=7;
const STORE='photos';
const SETTINGS_STORE='settings';
const APP_VERSION='7.0.0';

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

  await updateCount();
  updateNetworkState();

  window.addEventListener('online',async()=>{
    updateNetworkState();
    await retryPending();
  });
  window.addEventListener('offline',updateNetworkState);

  requestLocation();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js?v=7.0.0').catch(()=>{});
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

async function loadSettings(){
  // TEST 07: l'operatore conosce soltanto l'endpoint backend.
  return Object.assign({},window.FM_FOTO_DEFAULTS||{});
}

function requestLocation(){
  setState('wait','Acquisizione GPS…');
  disableCapture(true);

  if(!navigator.geolocation){
    setState('err','GPS non disponibile');
    $('readyTitle').textContent='GPS non disponibile';
    $('readySub').textContent='La posizione è necessaria.';
    return;
  }

  navigator.geolocation.getCurrentPosition(pos=>{
    currentPosition={
      lat:pos.coords.latitude,
      lng:pos.coords.longitude,
      accuracy:pos.coords.accuracy
    };

    setState('ok','Pronto');
    $('readyTitle').textContent='Pronto allo scatto';
    $('readySub').textContent=`Posizione acquisita · ±${Math.round(pos.coords.accuracy)} m`;
    disableCapture(false);
  },()=>{
    setState('err','GPS necessario');
    $('readyTitle').textContent='Posizione necessaria';
    $('readySub').textContent='Consenti la posizione per usare FM foto.';
  },{
    enableHighAccuracy:true,
    timeout:15000,
    maximumAge:15000
  });
}

async function handlePhoto(e){
  const file=e.target.files?.[0];
  if(!file||isBusy)return;

  if(!currentPosition){
    e.target.value='';
    requestLocation();
    return;
  }

  isBusy=true;
  disableCapture(true);
  showWorking('Elaborazione foto…','Salvataggio sicuro sul dispositivo.');

  let rec=null;

  try{
    const image=await compress(file,1600,.78);

    rec={
      image,
      createdAt:Date.now(),
      lat:currentPosition.lat,
      lng:currentPosition.lng,
      accuracy:currentPosition.accuracy,
      tags:['da classificare'],
      aiStatus:'pending',
      aiConfidence:null,
      aiSummary:'',
      syncStatus:'pending',
      backendStatus:'pending',
      driveFileId:'',
      schemaVersion:7,
      appVersion:APP_VERSION
    };

    rec.id=await addPhoto(rec);
    await updateCount();

    if(navigator.onLine){
      showWorking('Foto salvata','AI e Drive automatici…');

      const result=await sendToBackend(rec);

      rec.tags=normalizeTags(result.tags||[]);
      rec.aiStatus='classified';
      rec.aiConfidence=Number.isFinite(Number(result.confidence))?Number(result.confidence):null;
      rec.aiSummary=String(result.summary||'').slice(0,280);
      rec.syncStatus=result.driveUploaded?'synced':'pending';
      rec.backendStatus='completed';
      rec.driveFileId=result.driveFileId||'';
      rec.syncedAt=result.driveUploaded?Date.now():null;
      rec.lastError='';
      await putPhoto(rec);

      hideWorking();
      showSuccess('Foto classificata e archiviata automaticamente.');
    }else{
      hideWorking();
      showSuccess('Foto salvata. Verrà elaborata automaticamente appena torna la connessione.');
    }

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
    disableCapture(false);
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

      rec.tags=normalizeTags(result.tags||rec.tags||[]);
      rec.aiStatus='classified';
      rec.aiConfidence=Number.isFinite(Number(result.confidence))?Number(result.confidence):rec.aiConfidence;
      rec.aiSummary=String(result.summary||rec.aiSummary||'').slice(0,280);
      rec.backendStatus='completed';
      rec.syncStatus=result.driveUploaded?'synced':'pending';
      rec.driveFileId=result.driveFileId||rec.driveFileId||'';
      rec.syncedAt=result.driveUploaded?Date.now():rec.syncedAt;
      rec.lastError='';
      await putPhoto(rec);
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
        allowedTags:tagsVoc
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
function disableCapture(v){
  $('cameraInput').disabled=v;
  $('captureLabel').classList.toggle('disabled',v);
}
function setState(state,text){
  $('globalDot').className=`status-dot ${state}`;
  $('globalText').textContent=text;
}
function $(id){
  return document.getElementById(id);
}
