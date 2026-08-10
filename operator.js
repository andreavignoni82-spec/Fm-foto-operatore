const DB_NAME='famaferFotoCantiere';
const DB_VERSION=16;
const STORE='photos';
const SETTINGS_STORE='settings';
const APP_VERSION='7.7.3';

let db=null;
let currentPosition=null;
let settings={};
let isBusy=false;

const tagsVoc=[
 'cancello','recinzione','recinzione in lamiera','recinzione inox','recinzione zincata','recinzione verniciata','recinzione a doghe','recinzione grigliata',
 'ringhiera','parapetto','scala','soppalco','tettoia','pensilina','passerella','grigliato','carpenteria strutturale','trave','pilastro','capannone',
 'copertura','facciata','serramento','porta','portone','finestra','vetrata','pavimentazione','rivestimento','muro','muratura','calcestruzzo',
 'legno','acciaio','inox','alluminio','vetro','lamiera','pietra','laterizio','plastica','zincato','verniciato','satinato','lucido','grezzo','corten',
 'nero','bianco','grigio','interno','esterno','installato','montaggio','completato','dettaglio','cantiere','impianto elettrico','impianto idraulico',
 'illuminazione','quadro elettrico','tubazione','macchinario','attrezzatura','veicolo','arredo','mobile','tavolo','sedia','scaffalatura','giardino','verde',
 'marciapiede','strada','segnaletica','cartellonistica','edificio','abitazione','industriale','commerciale','artigianale','moderno','tradizionale'
];

document.addEventListener('DOMContentLoaded',init);

async function init(){
  db=await openDB();
  settings=await loadSettings();

  $('cameraInput').addEventListener('change',handlePhoto);
  bindNavigation();
  bindModal();
  renderTagFilters();
  $('archiveImportInput').addEventListener('change',handleArchiveImport);
  $('missingGpsBtn').addEventListener('click',async()=>{showMissingGpsOnly=!showMissingGpsOnly;$('missingGpsBtn').classList.toggle('primary',showMissingGpsOnly);await renderArchive();});
  $('assignCurrentLocationBtn').addEventListener('click',assignCurrentLocationToOpenPhoto);
  $('startQueueBtn').addEventListener('click',async()=>{
    await recoverInterruptedQueue();
    await processImportQueue(false);
  });

  $('retryQueueBtn').addEventListener('click',async()=>{
    $('retryQueueBtn').disabled=true;
    try{
      await resetFailedQueue();
      await processImportQueue(false);
    }finally{
      await updateQueueStatus();
    }
  });

  await updateCount();
  await updateQueueStatus();
  updateNetworkState();

  setState('ok','Pronto');
  $('readyTitle').textContent='Pronto allo scatto';
  $('readySub').textContent='Premi SCATTA FOTO. Dopo lo scatto verrà acquisita automaticamente la posizione.';

  window.addEventListener('online',async()=>{
    updateNetworkState();
    await recoverInterruptedQueue();
    await processImportQueue(false);
    await retryPending();
  });
  window.addEventListener('offline',updateNetworkState);

  // Tentativo silenzioso, ma non blocca mai il pulsante fotocamera.
  warmLocation();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js?v=7.7.2').catch(()=>{});
  }

  if(navigator.onLine){
    setTimeout(async()=>{
      await recoverInterruptedQueue();
      await processImportQueue(false);
      await retryPending();
    },1500);
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
    lat:(p.lat===null||p.lat===''||typeof p.lat==='undefined')?null:Number(p.lat), lng:(p.lng===null||p.lng===''||typeof p.lng==='undefined')?null:Number(p.lng), accuracy:Number(p.accuracy)||0,
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
  const pending=photos.filter(
    p=>
      p.source!=='archive-import' &&
      (
        p.backendStatus!=='completed' ||
        p.syncStatus!=='synced'
      )
  );

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
        manualTags:rec.manualTags||[],
        source:rec.source||'camera'
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
let showMissingGpsOnly=false;
let importQueueRunning=false;
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


function validEpochMs(value){
  const n=Number(value);
  if(!Number.isFinite(n))return null;

  // Between 2000-01-01 and tomorrow. Avoid bogus EXIF dates.
  const min=Date.UTC(2000,0,1);
  const max=Date.now()+86400000;

  return (n>=min && n<=max) ? n : null;
}

function parseExifDate(value){
  if(!value)return null;

  if(value instanceof Date){
    return validEpochMs(value.getTime());
  }

  if(typeof value==='number'){
    // exifr normally returns Date for EXIF date fields,
    // but accept timestamps defensively.
    if(value<1e12)value*=1000;
    return validEpochMs(value);
  }

  const raw=String(value).trim();
  if(!raw)return null;

  // EXIF standard style: YYYY:MM:DD HH:mm:ss
  const m=raw.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );

  if(m){
    const d=new Date(
      Number(m[1]),
      Number(m[2])-1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );

    return validEpochMs(d.getTime());
  }

  const parsed=Date.parse(raw);
  return validEpochMs(parsed);
}

function validCoordinate(value,min,max){
  const n=Number(value);
  return Number.isFinite(n) && n>=min && n<=max ? n : null;
}

async function readOriginalPhotoMetadata(file){
  const result={
    capturedAt:null,
    lat:null,
    lng:null,
    accuracy:0,
    dateSource:'none',
    gpsSource:'none',
    exifAvailable:false
  };

  if(window.exifr){
    // 1) Full EXIF/TIFF/HEIF parse for original capture date.
    try{
      const parsed=await exifr.parse(file,{
        tiff:true,
        exif:true,
        gps:true,
        ifd0:true,
        ifd1:false,
        interop:false,
        makerNote:false,
        userComment:false,
        xmp:true,
        icc:false,
        iptc:false,
        jfif:false,
        pick:[
          'DateTimeOriginal',
          'CreateDate',
          'ModifyDate',
          'DateTime',
          'OffsetTimeOriginal',
          'OffsetTimeDigitized',
          'OffsetTime',
          'GPSLatitude',
          'GPSLongitude',
          'GPSLatitudeRef',
          'GPSLongitudeRef',
          'latitude',
          'longitude',
          'GPSHPositioningError'
        ]
      })||{};

      result.exifAvailable=Object.keys(parsed).length>0;

      const dateCandidates=[
        ['DateTimeOriginal',parsed.DateTimeOriginal],
        ['CreateDate',parsed.CreateDate],
        ['DateTime',parsed.DateTime],
        ['ModifyDate',parsed.ModifyDate]
      ];

      for(const [source,value] of dateCandidates){
        const ms=parseExifDate(value);
        if(ms!==null){
          result.capturedAt=ms;
          result.dateSource='EXIF:'+source;
          break;
        }
      }

      const pLat=validCoordinate(parsed.latitude,-90,90);
      const pLng=validCoordinate(parsed.longitude,-180,180);

      if(pLat!==null && pLng!==null){
        result.lat=pLat;
        result.lng=pLng;
        result.gpsSource='EXIF:parse';
      }

      if(Number.isFinite(Number(parsed.GPSHPositioningError))){
        result.accuracy=Math.max(0,Number(parsed.GPSHPositioningError));
      }
    }catch(err){
      console.warn('EXIF completo non leggibile',err);
    }

    // 2) Dedicated exifr GPS parser.
    // exifr documents gps(file) as the optimized latitude/longitude extractor.
    if(result.lat===null || result.lng===null){
      try{
        const gps=await exifr.gps(file);

        const gLat=validCoordinate(gps?.latitude,-90,90);
        const gLng=validCoordinate(gps?.longitude,-180,180);

        if(gLat!==null && gLng!==null){
          result.lat=gLat;
          result.lng=gLng;
          result.gpsSource='EXIF:gps';
        }
      }catch(err){
        console.warn('GPS EXIF dedicato non leggibile',err);
      }
    }
  }

  // 3) Browser File metadata is only a FALLBACK for the date.
  // Never replace an EXIF original date with import time.
  if(result.capturedAt===null){
    const fallback=validEpochMs(file?.lastModified);

    if(fallback!==null){
      result.capturedAt=fallback;
      result.dateSource='FILE:lastModified';
    }
  }

  // Absolute last resort only when browser supplies no useful time at all.
  if(result.capturedAt===null){
    result.capturedAt=Date.now();
    result.dateSource='IMPORT_TIME';
  }

  return result;
}

async function handleArchiveImport(e){
  const files=[...(e.target.files||[])];
  if(!files.length)return;

  $('importProgress').classList.remove('hidden');

  let saved=0;
  let failed=0;

  // FASE 1: salva TUTTE le foto localmente. Nessuna chiamata AI/Drive qui.
  for(let i=0;i<files.length;i++){
    const file=files[i];

    $('importProgressTitle').textContent=`Salvataggio ${i+1}/${files.length}`;
    $('importProgressSub').textContent=file.name;

    try{
      // IMPORTANT: read metadata from ORIGINAL file before compression.
      const originalMeta=await readOriginalPhotoMetadata(file);

      const capturedAt=originalMeta.capturedAt;
      const lat=originalMeta.lat;
      const lng=originalMeta.lng;

      // Only after metadata extraction we create the compressed upload image.
      const image=await compress(file,1600,.78);

      const rec={
        image,
        createdAt:capturedAt,
        originalFileName:file.name||'',
        lat,
        lng,
        accuracy:originalMeta.accuracy||0,
        dateSource:originalMeta.dateSource,
        gpsSource:originalMeta.gpsSource,
        originalExifAvailable:!!originalMeta.exifAvailable,

        tags:['da classificare'],
        manualTags:[],

        aiStatus:'pending',
        aiConfidence:null,
        aiSummary:'',

        syncStatus:'pending',
        backendStatus:'pending',

        importQueueStatus:'pending',
        importAttempts:0,
        importLastAttempt:0,
        importLastError:'',

        driveFileId:'',
        source:'archive-import',

        schemaVersion:16,
        appVersion:APP_VERSION
      };

      await addPhoto(rec);
      saved++;

      console.info(
        'FM Foto import metadata',
        file.name,
        {
          capturedAt:new Date(capturedAt).toISOString(),
          dateSource:originalMeta.dateSource,
          lat,
          lng,
          gpsSource:originalMeta.gpsSource
        }
      );

    }catch(err){
      console.warn('Salvataggio import fallito',file.name,err);
      failed++;
    }
  }

  e.target.value='';

  await updateCount();
  await updateQueueStatus();
  await renderArchive();

  $('importProgressTitle').textContent='Foto messe in coda';
  $('importProgressSub').textContent=
    `${saved} salvate localmente${failed?` · ${failed} non importate`:''}`;

  // Nasconde il riquadro di import, ma la coda resta visibile.
  setTimeout(()=>$('importProgress').classList.add('hidden'),2500);

  // FASE 2: elabora la coda separatamente, una foto alla volta.
  if(navigator.onLine){
    // Su iOS/Safari attendiamo esplicitamente la coda.
    await processImportQueue(false);
  }
}

async function recoverInterruptedQueue(){
  const photos=await getAllPhotos();

  for(const rec of photos){
    if(rec.source==='archive-import' && rec.importQueueStatus==='processing'){
      rec.importQueueStatus='pending';
      rec.backendStatus='pending';
      rec.syncStatus='pending';
      await putPhoto(rec);
    }
  }

  await updateQueueStatus();
}

async function resetFailedQueue(){
  const photos=await getAllPhotos();

  for(const rec of photos){
    if(
      rec.source==='archive-import' &&
      (
        rec.importQueueStatus==='error' ||
        rec.backendStatus==='error'
      ) &&
      rec.syncStatus!=='synced'
    ){
      rec.importQueueStatus='pending';
      rec.backendStatus='pending';
      rec.importLastError='';
      rec.lastError='';
      await putPhoto(rec);
    }
  }

  await updateQueueStatus();
  await renderArchive();
}

async function processImportQueue(forceRetry=false){
  if(importQueueRunning){
    return;
  }

  if(!navigator.onLine || !settings.backendEndpoint){
    await updateQueueStatus();
    return;
  }

  importQueueRunning=true;

  if($('startQueueBtn'))$('startQueueBtn').disabled=true;
  if($('retryQueueBtn'))$('retryQueueBtn').disabled=true;

  const attemptedThisRun=new Set();

  try{
    while(true){
      const photos=await getAllPhotos();

      const rec=photos.find(p=>{
        if(p.source!=='archive-import')return false;
        if(p.syncStatus==='synced')return false;
        if(attemptedThisRun.has(String(p.id)))return false;

        if(p.importQueueStatus==='pending' || !p.importQueueStatus){
          return true;
        }

        if(forceRetry && p.importQueueStatus==='error'){
          return true;
        }

        return false;
      });

      if(!rec)break;

      attemptedThisRun.add(String(rec.id));

      rec.importQueueStatus='processing';
      rec.backendStatus='processing';
      rec.importAttempts=(Number(rec.importAttempts)||0)+1;
      rec.importLastAttempt=Date.now();
      rec.importLastError='';
      await putPhoto(rec);

      await updateQueueStatus();

      if($('archiveView')?.classList.contains('active')){
        await renderArchive();
      }

      try{
        const result=await sendToBackend(rec);

        rec.tags=normalizeTags([
          ...(result.tags||[]),
          ...(rec.manualTags||[])
        ]);

        // Rispetta il vero stato AI restituito dal Worker V2.8.
        rec.aiStatus=result.aiStatus||'classified';

        rec.aiConfidence=
          Number.isFinite(Number(result.confidence))
            ? Number(result.confidence)
            : null;

        rec.aiSummary=
          String(result.summary||'')
            .slice(0,280);

        rec.aiError=
          String(result.aiError||'')
            .slice(0,250);

        if(result.driveUploaded===true){
          rec.syncStatus='synced';
          rec.backendStatus='completed';
          rec.importQueueStatus='synced';

          rec.driveFileId=
            result.driveFileId||
            rec.driveFileId||
            '';

          rec.syncedAt=Date.now();
          rec.importLastError='';
          rec.lastError='';
        }else{
          rec.syncStatus='pending';
          rec.backendStatus='error';
          rec.importQueueStatus='error';
          rec.importLastError='Il backend non ha confermato il salvataggio Drive.';
          rec.lastError=rec.importLastError;
        }

        await putPhoto(rec);
        sharedArchiveFetchedAt=0;

      }catch(err){
        const message=String(err?.message||err);

        rec.importQueueStatus='error';
        rec.backendStatus='error';
        rec.syncStatus='pending';
        rec.importLastError=message;
        rec.lastError=message;

        await putPhoto(rec);

        console.warn(
          'Import queue error',
          rec.originalFileName||rec.id,
          message
        );
      }

      await updateQueueStatus();

      if($('archiveView')?.classList.contains('active')){
        await renderArchive();
      }

      // Su iPhone lasciamo tempo al browser tra upload consecutivi.
      await new Promise(resolve=>setTimeout(resolve,700));
    }

    sharedArchiveFetchedAt=0;

    try{
      await fetchSharedArchive(true);
    }catch{}

  }finally{
    importQueueRunning=false;

    await updateQueueStatus();

    if($('archiveView')?.classList.contains('active')){
      await renderArchive();
    }
  }
}

async function updateQueueStatus(){
  const photos=await getAllPhotos();

  const imports=photos.filter(
    p=>p.source==='archive-import'
  );

  const done=imports.filter(
    p=>p.syncStatus==='synced'
  ).length;

  const processing=imports.filter(
    p=>p.importQueueStatus==='processing'
  ).length;

  const errors=imports.filter(
    p=>p.importQueueStatus==='error' && p.syncStatus!=='synced'
  ).length;

  const pending=imports.filter(
    p=>
      p.syncStatus!=='synced' &&
      (
        p.importQueueStatus==='pending' ||
        !p.importQueueStatus
      )
  ).length;

  const total=imports.length;

  if($('queueDone'))$('queueDone').textContent=done;
  if($('queuePending'))$('queuePending').textContent=pending;
  if($('queueErrors'))$('queueErrors').textContent=errors;

  const completedForProgress=
    done+errors;

  const pct=
    total
      ? Math.round((completedForProgress/total)*100)
      : 0;

  if($('queueProgressBar')){
    $('queueProgressBar').style.width=`${pct}%`;
  }

  let text='Nessuna foto in attesa.';

  if(total){
    if(processing){
      text=`Elaborazione in corso · ${done}/${total} sincronizzate`;
    }else if(pending){
      text=`${pending} foto da caricare · ${done}/${total} sincronizzate`;
    }else if(errors){
      text=`${errors} foto da riprovare · ${done}/${total} sincronizzate`;
    }else{
      text=`Completata · ${done}/${total} sincronizzate`;
    }
  }

  if($('queueStatusText')){
    $('queueStatusText').textContent=text;
  }

  if($('startQueueBtn')){
    $('startQueueBtn').disabled=
      importQueueRunning ||
      pending===0;
  }

  if($('retryQueueBtn')){
    $('retryQueueBtn').disabled=
      importQueueRunning ||
      errors===0;
  }
}

async function assignCurrentLocationToOpenPhoto(){
  if(currentModalPhotoId==null)return;
  let pos; try{pos=await acquireLocation()}catch(err){alert(String(err?.message||err));return}
  const p=await resolvePhoto(currentModalPhotoId); if(!p)return;
  p.lat=pos.lat;p.lng=pos.lng;p.accuracy=pos.accuracy||0;
  if(p.remote||p.driveFileId){
    const res=await fetch(settings.backendEndpoint.replace(/\/$/,'')+'/update-location',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({driveFileId:p.driveFileId,lat:p.lat,lng:p.lng,accuracy:p.accuracy})});
    const text=await res.text();let data; try{data=JSON.parse(text)}catch{throw new Error(text.slice(0,200))}
    if(!res.ok||!data.ok)throw new Error(data.message||data.error||'Aggiornamento posizione fallito'); sharedArchiveFetchedAt=0; await fetchSharedArchive(true);
  }else{
    const local=await getAllPhotos(); const rec=local.find(x=>String(x.id)===String(p.id)); if(rec){rec.lat=p.lat;rec.lng=p.lng;rec.accuracy=p.accuracy;rec.backendStatus='pending';rec.syncStatus='pending';await putPhoto(rec)}
  }
  refreshModalMeta(p); await refreshVisibleViews();
}

async function renderArchive(){
  await updateQueueStatus();
  let photos=await getUnifiedPhotos(true);
  if(showMissingGpsOnly){photos=photos.filter(p=>p.lat===null||p.lng===null||!Number.isFinite(Number(p.lat))||!Number.isFinite(Number(p.lng)));}
  const host=$('archiveGallery'); if(!host)return;
  $('archiveEmpty').classList.toggle('hidden',photos.length>0);
  host.innerHTML=photos.map(photoCardHTML).join(''); bindPhotoCards(host,photos);
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
  const noGps=(
    p.lat===null||
    p.lng===null||
    !Number.isFinite(Number(p.lat))||
    !Number.isFinite(Number(p.lng))
  );

  let queueClass='';
  let queueLabel='';

  if(p.source==='archive-import' && !p.remote){
    if(p.syncStatus==='synced'){
      queueClass='queue-synced';
      queueLabel='✓ Drive';
    }else if(p.importQueueStatus==='processing'){
      queueClass='queue-processing';
      queueLabel='Elaborazione';
    }else if(p.importQueueStatus==='error'){
      queueClass='queue-error';
      queueLabel='Da riprovare';
    }else{
      queueClass='queue-pending';
      queueLabel='In coda';
    }
  }

  return `<button class="photo-card ${noGps?'no-gps':''} ${queueClass}" data-id="${escapeHtml(p.id)}">
    <img src="${p.image}" alt="Foto cantiere">
    ${queueLabel?`<span class="queue-photo-badge">${escapeHtml(queueLabel)}</span>`:''}
    <div class="overlay">${new Date(p.createdAt).toLocaleDateString('it-IT')}<br>${(p.tags||[]).slice(0,3).map(escapeHtml).join(' · ')}</div>
  </button>`;
}

function bindPhotoCards(host,all){
  host.querySelectorAll('.photo-card').forEach(card=>{
    card.onclick=()=>openPhoto(card.dataset.id,all);
  });
}

function openPhoto(id,all){
  const p=all.find(x=>String(x.id)===String(id)); if(!p)return;
  currentModalPhotoId=String(id); $('modalImg').src=p.image;
  const hasGps=p.lat!==null&&p.lng!==null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng));
  $('modalMeta').innerHTML=`<strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong><div class="muted">${p.dateSource?`Data: ${escapeHtml(p.dateSource)}<br>`:''}${hasGps?`GPS ${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)} · ±${Math.round(p.accuracy||0)} m${p.gpsSource?` · ${escapeHtml(p.gpsSource)}`:''}`:'Posizione non presente nel file selezionato'}</div><div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>${p.aiSummary?`<div class="ai-summary">${escapeHtml(p.aiSummary)}</div>`:''}`;
  $('assignCurrentLocationBtn').classList.toggle('hidden',hasGps); renderManualTagEditor(p); $('photoModal').classList.remove('hidden');
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
  const hasGps=p.lat!==null&&p.lng!==null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng));
  $('modalMeta').innerHTML=`<strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong><div class="muted">${p.dateSource?`Data: ${escapeHtml(p.dateSource)}<br>`:''}${hasGps?`GPS ${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)} · ±${Math.round(p.accuracy||0)} m${p.gpsSource?` · ${escapeHtml(p.gpsSource)}`:''}`:'Posizione non presente nel file selezionato'}</div><div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>${p.aiSummary?`<div class="ai-summary">${escapeHtml(p.aiSummary)}</div>`:''}`;
  $('assignCurrentLocationBtn').classList.toggle('hidden',hasGps);
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
  const all=(await getUnifiedPhotos()).filter(p=>p.lat!==null&&p.lng!==null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng)));
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
