const DB_NAME='famaferFotoCantiere';
const DB_VERSION=22;
const STORE='photos';
const SETTINGS_STORE='settings';
const APP_VERSION='7.7.8';

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


async function retryBackendAICheckOnce(){
  await new Promise(
    resolve=>setTimeout(resolve,1800)
  );

  const label=
    document.getElementById('aiStatusText');

  const current=
    String(label?.textContent||'');

  if(
    current.includes('verifica') ||
    current.includes('backend lento') ||
    current.includes('non raggiungibile')
  ){
    await checkBackendAI();
  retryBackendAICheckOnce();
  }
}

async function init(){
  db=await openDB();
  settings=await loadSettings();

  $('cameraInput').addEventListener('change',handlePhoto);
  bindNavigation();
  bindModal();
  renderTagFilters();
  $('archiveImportInput').addEventListener('change',handleArchiveImport);
  $('missingGpsBtn').addEventListener('click',async()=>{showMissingGpsOnly=!showMissingGpsOnly;$('missingGpsBtn').classList.toggle('primary',showMissingGpsOnly);await renderArchive();});
  $('archiveSelectBtn').addEventListener('click',toggleArchiveSelectionMode);
  $('archiveShareBtn').addEventListener('click',()=>shareSelectedPhotos('archive'));
  $('archiveDeleteBtn').addEventListener('click',deleteSelectedArchivePhotos);

  $('tagSearchInput').addEventListener('input',async e=>{
    tagSearchQuery=String(e.target.value||'').trim();
    $('tagSearchClearBtn').classList.toggle('hidden',!tagSearchQuery);
    await renderTagGallery();
  });

  $('tagSearchClearBtn').addEventListener('click',async()=>{
    tagSearchQuery='';
    $('tagSearchInput').value='';
    $('tagSearchClearBtn').classList.add('hidden');
    await renderTagGallery();
    $('tagSearchInput').focus();
  });

  $('tagSelectBtn').addEventListener('click',toggleTagSelectionMode);
  $('tagSelectAllBtn').addEventListener('click',selectAllCurrentTagPhotos);
  $('tagClearSelectionBtn').addEventListener('click',clearBulkSelection);
  $('tagShareBtn').addEventListener('click',()=>shareSelectedPhotos('tag'));
  $('mapSelectAllBtn').addEventListener('click',selectAllCurrentMapGroup);
  $('mapClearSelectionBtn').addEventListener('click',clearBulkSelection);
  $('mapShareSelectedBtn').addEventListener('click',()=>shareSelectedPhotos('map'));
  $('closeMapLocationBtn').addEventListener('click',closeMapLocationGroup);
  $('assignCurrentLocationBtn').addEventListener('click',assignCurrentLocationToOpenPhoto);
  $('saveManualTagsBtn').addEventListener('click',saveCurrentManualTags);
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
  await checkBackendAI();
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

      applyBackendResultToRecord(rec,result);
      await putPhoto(rec);
      sharedArchiveFetchedAt=0;

      hideWorking();
      showSuccess(
        rec.aiStatus==='classified'
          ? 'Foto classificata e archiviata automaticamente.'
          : 'Foto archiviata. AI temporaneamente non disponibile.'
      );
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

  const endpoint=settings.backendEndpoint.replace(/\/$/,'')+'/process';

  setAIStatus('working','AI: analisi in corso…');

  const res=await fetch(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      localId:String(rec.id),
      image:rec.image,
      capturedAt:rec.capturedAt||rec.createdAt||Date.now(),
      lat:rec.lat,
      lng:rec.lng,
      accuracy:rec.accuracy,
      allowedTags:tagsVoc,
      manualTags:rec.manualTags||[],
      source:rec.source||'camera',
      skipAI:false
    })
  });

  const text=await res.text();
  let data;

  try{
    data=JSON.parse(text);
  }catch{
    throw new Error(`Backend ${res.status}: ${text.slice(0,200)}`);
  }

  if(!res.ok||!data.ok){
    const msg=data.message||data.error||`Backend ${res.status}`;
    setAIStatus('error',`AI/backend: ${msg}`);
    throw new Error(msg);
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


function setAIStatus(kind,text){
  const bar=document.getElementById('aiStatusBar');
  const label=document.getElementById('aiStatusText');
  if(!bar||!label)return;
  bar.classList.remove('ai-status-neutral','ai-status-ok','ai-status-working','ai-status-warning','ai-status-error');
  const safe=['ok','working','warning','error'].includes(kind)?kind:'neutral';
  bar.classList.add(`ai-status-${safe}`);
  label.textContent=text||'AI';
}

function applyBackendResultToRecord(rec,result){
  const aiTags=normalizeTags(result.tags||rec.tags||[]);
  rec.tags=normalizeTags([...(aiTags||[]),...(rec.manualTags||[])]);
  rec.aiStatus=result.aiStatus||(
    result.aiAvailable===false ? 'error' : 'classified'
  );
  rec.aiConfidence=Number.isFinite(Number(result.confidence))
    ? Number(result.confidence)
    : rec.aiConfidence;
  rec.aiSummary=String(result.summary||rec.aiSummary||'').slice(0,280);
  rec.aiError=String(result.aiError||'').slice(0,250);
  rec.syncStatus=result.driveUploaded?'synced':'pending';
  rec.backendStatus='completed';
  rec.driveFileId=result.driveFileId||rec.driveFileId||'';
  rec.syncedAt=result.driveUploaded?Date.now():rec.syncedAt;
  rec.lastError='';

  if(rec.aiStatus==='classified'){
    setAIStatus('ok','AI: classificazione completata');
  }else if(rec.aiStatus==='error'){
    const e=rec.aiError.toLowerCase();
    if(e.includes('4006')||e.includes('quota')||e.includes('daily free allocation')||e.includes('10,000 neurons')){
      setAIStatus('warning','AI: quota gratuita esaurita · foto archiviata');
    }else{
      setAIStatus('error',`AI: ${rec.aiError||'classificazione non disponibile'}`);
    }
  }else{
    setAIStatus('warning','AI: foto archiviata · classificazione non disponibile');
  }
}


async function fetchWithTimeout(url,options={},timeoutMs=5000){
  const controller=new AbortController();
  const timer=setTimeout(
    ()=>controller.abort(),
    timeoutMs
  );

  try{
    return await fetch(url,{
      ...options,
      signal:controller.signal
    });
  }finally{
    clearTimeout(timer);
  }
}

async function checkBackendAI(){
  const endpoint=String(
    settings?.backendEndpoint||''
  ).trim();

  if(!endpoint){
    setAIStatus(
      'error',
      'AI: backend non configurato'
    );
    return false;
  }

  const rootUrl=
    endpoint.replace(/\/+$/,'') + '/';

  setAIStatus(
    'working',
    'AI: verifica backend…'
  );

  try{
    const res=await fetchWithTimeout(
      rootUrl,
      {
        method:'GET',
        cache:'no-store',
        headers:{
          'Accept':'application/json'
        }
      },
      5000
    );

    if(!res.ok){
      setAIStatus(
        'error',
        `AI/backend: HTTP ${res.status}`
      );

      console.error(
        'FM Foto AI startup check HTTP error',
        res.status,
        rootUrl
      );

      return false;
    }

    const text=await res.text();
    let data={};

    try{
      data=text
        ? JSON.parse(text)
        : {};
    }catch(err){
      setAIStatus(
        'error',
        'AI/backend: risposta non valida'
      );

      console.error(
        'FM Foto AI startup JSON error',
        err,
        text
      );

      return false;
    }

    const version=
      String(data?.version||'?');

    const aiBinding=
      data?.config?.aiBinding;

    if(aiBinding===true){
      setAIStatus(
        'ok',
        `AI: disponibile · Worker ${version}`
      );

      console.info(
        'FM Foto AI startup OK',
        data
      );

      return true;
    }

    if(aiBinding===false){
      setAIStatus(
        'warning',
        `AI: binding Cloudflare non configurato · Worker ${version}`
      );

      console.warn(
        'FM Foto AI binding missing',
        data
      );

      return false;
    }

    setAIStatus(
      'warning',
      `AI: Worker ${version} raggiungibile · stato binding non dichiarato`
    );

    console.warn(
      'FM Foto AI binding state unknown',
      data
    );

    return false;

  }catch(err){
    const isAbort=
      err?.name==='AbortError';

    if(isAbort){
      setAIStatus(
        'warning',
        'AI: verifica scaduta · backend lento/non raggiungibile'
      );

      console.warn(
        'FM Foto AI startup timeout',
        rootUrl
      );
    }else{
      setAIStatus(
        'error',
        'AI: backend non raggiungibile'
      );

      console.error(
        'FM Foto AI startup network/CORS error',
        err,
        rootUrl
      );
    }

    return false;
  }
}

function normalizeTags(a){
  return [...new Set(
    (a||[])
      .map(x=>String(x).trim().toLowerCase())
      .filter(Boolean)
  )].slice(0,8);
}
function visibleClassificationTags(photo){
  const combined=normalizeTags([...(photo?.tags||[]),...(photo?.manualTags||[])]);
  const placeholders=new Set(['da classificare','da-classificare','non classificato','non classificata','pending']);
  const real=combined.filter(t=>!placeholders.has(String(t||'').trim().toLowerCase()));
  return real.length ? real : ['da classificare'];
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
let bulkSelectedIds=new Set();
let archiveSelectionMode=false;
let tagSelectionMode=false;
let currentTagPhotos=[];
let tagSearchQuery='';
let currentMapGroup=[];

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

        applyBackendResultToRecord(rec,result);

        if(result.driveUploaded===true){
          rec.importQueueStatus='synced';
          rec.importLastError='';
        }else{
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


function updateBulkSelectionUI(){
  const count=bulkSelectedIds.size;
  const a=$('archiveShareBtn');
  const m=$('mapShareSelectedBtn');
  const t=$('tagShareBtn');

  if(a){
    a.textContent=`Condividi (${count})`;
    a.disabled=count===0;
    a.classList.toggle('hidden',!archiveSelectionMode);
  }

  const d=$('archiveDeleteBtn');
  if(d){
    d.textContent=`🗑 Elimina (${count})`;
    d.disabled=count===0;
    d.classList.toggle('hidden',!archiveSelectionMode);
  }

  if(m){
    const mapCount=currentMapGroup.filter(p=>bulkSelectedIds.has(String(p.id))).length;
    m.textContent=`Condividi (${mapCount})`;
    m.disabled=mapCount===0;
  }

  if(t){
    const tagCount=currentTagPhotos.filter(p=>bulkSelectedIds.has(String(p.id))).length;
    t.textContent=`Condividi (${tagCount})`;
    t.disabled=tagCount===0;
    t.classList.toggle('hidden',!tagSelectionMode);
  }

  const selectAll=$('tagSelectAllBtn');
  const clear=$('tagClearSelectionBtn');

  if(selectAll)selectAll.classList.toggle('hidden',!tagSelectionMode);
  if(clear)clear.classList.toggle('hidden',!tagSelectionMode);
}

async function toggleArchiveSelectionMode(){
  archiveSelectionMode=!archiveSelectionMode;
  bulkSelectedIds.clear();
  $('archiveSelectBtn').textContent=archiveSelectionMode?'Annulla selezione':'Seleziona';
  $('archiveSelectBtn').classList.toggle('primary',archiveSelectionMode);
  updateBulkSelectionUI();
  await renderArchive();
}

async function toggleTagSelectionMode(){
  tagSelectionMode=!tagSelectionMode;
  bulkSelectedIds.clear();

  $('tagSelectBtn').textContent=
    tagSelectionMode
      ? 'Annulla selezione'
      : 'Seleziona';

  $('tagSelectBtn').classList.toggle(
    'primary',
    tagSelectionMode
  );

  updateBulkSelectionUI();
  await renderTagGallery();
}

function selectAllCurrentTagPhotos(){
  currentTagPhotos.forEach(
    p=>bulkSelectedIds.add(String(p.id))
  );

  renderTagGallery();
  updateBulkSelectionUI();
}

function toggleBulkPhoto(photoId,force){
  const id=String(photoId);
  const shouldSelect=typeof force==='boolean'?force:!bulkSelectedIds.has(id);
  if(shouldSelect)bulkSelectedIds.add(id); else bulkSelectedIds.delete(id);
  updateBulkSelectionUI();
  document.querySelectorAll(`[data-select-photo-id="${CSS.escape(id)}"]`).forEach(b=>{
    b.classList.toggle('selected',shouldSelect);
    b.textContent=shouldSelect?'✓':'○';
  });
  document.querySelectorAll(`.photo-card[data-id="${CSS.escape(id)}"]`).forEach(c=>c.classList.toggle('bulk-selected',shouldSelect));
}

function clearBulkSelection(){
  bulkSelectedIds.clear();
  document.querySelectorAll('.photo-card.bulk-selected').forEach(c=>c.classList.remove('bulk-selected'));
  document.querySelectorAll('.photo-select-toggle').forEach(b=>{b.classList.remove('selected');b.textContent='○';});
  updateBulkSelectionUI();
}

function selectAllCurrentMapGroup(){
  currentMapGroup.forEach(p=>bulkSelectedIds.add(String(p.id)));
  renderMapLocationGroupCards();
  updateBulkSelectionUI();
}

function photoFileName(p,index=0){
  const date=new Date(Number(p.createdAt)||Date.now());
  const stamp=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}-${String(date.getMinutes()).padStart(2,'0')}`;
  return `FM-Foto_${stamp}_${index+1}.jpg`;
}

async function photoToShareFile(p,index){
  const response=await fetch(p.image,{cache:'no-store'});
  if(!response.ok)throw new Error(`Impossibile scaricare una foto (${response.status})`);
  const blob=await response.blob();
  const type=blob.type&&blob.type.startsWith('image/')?blob.type:'image/jpeg';
  return new File([blob],photoFileName(p,index),{type,lastModified:Number(p.createdAt)||Date.now()});
}


async function deleteLocalPhotoById(photoId){
  try{
    const db=await openDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('photos','readwrite');
      const store=tx.objectStore('photos');
      const req=store.delete(photoId);

      req.onsuccess=()=>resolve();
      req.onerror=()=>reject(req.error);
    });
  }catch(err){
    console.warn('Eliminazione foto locale non completata',photoId,err);
  }
}

async function deleteDrivePhoto(photo){
  if(!photo?.driveFileId){
    return {ok:true,localOnly:true};
  }

  if(!settings?.backendEndpoint){
    throw new Error('Backend non configurato');
  }

  const endpoint=
    settings.backendEndpoint.replace(/\/+$/,'')+
    '/delete-photo';

  const res=await fetch(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      driveFileId:String(photo.driveFileId)
    })
  });

  const text=await res.text();
  let data={};

  try{
    data=text?JSON.parse(text):{};
  }catch{
    throw new Error(`Backend ${res.status}: ${text.slice(0,200)}`);
  }

  if(!res.ok||!data.ok){
    throw new Error(
      data.message||
      data.error||
      `Backend ${res.status}`
    );
  }

  return data;
}

async function deleteSelectedArchivePhotos(){
  const all=await getUnifiedPhotos();
  const ids=[...bulkSelectedIds];

  const photos=
    ids
      .map(id=>all.find(p=>String(p.id)===String(id)))
      .filter(Boolean);

  if(!photos.length){
    alert('Seleziona almeno una foto da eliminare.');
    return;
  }

  const n=photos.length;

  const confirmed=confirm(
    n===1
      ? 'Eliminare definitivamente questa foto dall’archivio e da Google Drive?'
      : `Eliminare definitivamente ${n} foto dall’archivio e da Google Drive?`
  );

  if(!confirmed)return;

  const btn=$('archiveDeleteBtn');
  const oldText=btn?.textContent||`🗑 Elimina (${n})`;

  if(btn){
    btn.disabled=true;
    btn.textContent='Eliminazione…';
  }

  let deleted=0;
  const errors=[];

  for(const photo of photos){
    try{
      /*
        Prima elimina dal Drive condiviso.
        Solo dopo rimuove la copia locale.
        In questo modo non perdiamo il riferimento
        se il backend dovesse fallire.
      */
      await deleteDrivePhoto(photo);

      await deleteLocalPhotoById(photo.id);

      bulkSelectedIds.delete(String(photo.id));
      deleted++;

    }catch(err){
      console.error(
        'FM Foto eliminazione:',
        photo?.id,
        err
      );

      errors.push({
        photo,
        message:String(err?.message||err)
      });
    }
  }

  /*
    Invalida la cache condivisa e ricarica l'archivio reale dal Worker.
    La funzione corretta esistente in questa versione è fetchSharedArchive().
  */
  sharedArchiveFetchedAt=0;
  sharedArchiveCache=[];

  await fetchSharedArchive(true).catch(err=>{
    console.warn('Aggiornamento archivio dopo eliminazione non riuscito',err);
  });

  await refreshVisibleViews();

  if(deleted>0){
    alert(
      deleted===1
        ? 'Foto eliminata definitivamente.'
        : `${deleted} foto eliminate definitivamente.`
    );
  }

  if(errors.length){
    alert(
      `${errors.length} foto non sono state eliminate.\n\n`+
      errors
        .slice(0,5)
        .map(e=>e.message)
        .join('\n')
    );
  }

  updateBulkSelectionUI();

  if(btn){
    btn.disabled=bulkSelectedIds.size===0;
    btn.textContent=`🗑 Elimina (${bulkSelectedIds.size})`;
  }
}

async function shareSelectedPhotos(source){
  const all=await getUnifiedPhotos();
  let ids=[...bulkSelectedIds];

  if(source==='map'){
    const allowed=new Set(currentMapGroup.map(p=>String(p.id)));
    ids=ids.filter(id=>allowed.has(String(id)));
  }

  if(source==='tag'){
    const allowed=new Set(currentTagPhotos.map(p=>String(p.id)));
    ids=ids.filter(id=>allowed.has(String(id)));
  }

  const photos=ids.map(id=>all.find(p=>String(p.id)===String(id))).filter(Boolean);
  if(!photos.length){alert('Seleziona almeno una foto.');return;}

  const btn=
    source==='map'
      ? $('mapShareSelectedBtn')
      : source==='tag'
        ? $('tagShareBtn')
        : $('archiveShareBtn');
  const oldText=btn?.textContent||'';
  if(btn){btn.disabled=true;btn.textContent='Preparo foto…';}

  try{
    const files=[];
    for(let i=0;i<photos.length;i++)files.push(await photoToShareFile(photos[i],i));

    if(navigator.share && (!navigator.canShare || navigator.canShare({files}))){
      await navigator.share({
        title:`FM Foto · ${files.length} foto`,
        text:`${files.length} fotografie selezionate da FM Foto`,
        files
      });
    }else{
      throw new Error('La condivisione multipla di fotografie non è supportata da questo browser. Apri FM Foto da Safari/iPhone o da un browser compatibile.');
    }
  }catch(err){
    if(err?.name!=='AbortError')alert(String(err?.message||err));
  }finally{
    if(btn){btn.disabled=false;btn.textContent=oldText;}
    updateBulkSelectionUI();
  }
}

async function renderArchive(){
  await updateQueueStatus();
  let photos=await getUnifiedPhotos(true);
  if(showMissingGpsOnly){photos=photos.filter(p=>p.lat===null||p.lng===null||!Number.isFinite(Number(p.lat))||!Number.isFinite(Number(p.lng)));}
  const host=$('archiveGallery'); if(!host)return;
  $('archiveEmpty').classList.toggle('hidden',photos.length>0);
  host.innerHTML=photos.map(p=>photoCardHTML(p,{selectable:archiveSelectionMode,selected:bulkSelectedIds.has(String(p.id))})).join(''); bindPhotoCards(host,photos,{selectionMode:archiveSelectionMode});
  updateBulkSelectionUI();
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


const TAG_SEARCH_GROUPS=[
  ['ringhiera','ringhiere','parapetto','parapetti','corrimano','balaustra','balaustre'],
  ['cancello','cancelli','carrabile','pedonale','cancello scorrevole','cancello battente'],
  ['recinzione','recinzioni','recinto','rete','grigliato','grigliata','pannello recinzione','staccionata'],
  ['scala','scale','gradino','gradini','pedata','cosciale','rampe','rampa'],
  ['tettoia','tettoie','pensilina','pensiline','copertura','coperture'],
  ['carpenteria','struttura metallica','carpenteria strutturale','struttura acciaio','strutture metalliche'],
  ['trave','travi','ipe','hea','heb','upn','unp','profilo','profili'],
  ['pilastro','pilastri','colonna','colonne','montante','montanti'],
  ['piastra','piastre','piastra base','flangia','flange','staffa','staffe','mensola','mensole'],
  ['lamiera','lamiere','lamiera piegata','lamiera forata','lamiera grecata','lamiera stirata'],
  ['rete','reti','rete elettrosaldata','rete stirata','grigliato','grigliati'],
  ['inox','acciaio inox','acciaio inossidabile','inossidabile'],
  ['zincato','zincata','zincati','zincate','zincatura','zincato a caldo'],
  ['verniciato','verniciata','verniciati','verniciate','verniciatura','verniciato a polvere'],
  ['saldato','saldata','saldati','saldate','saldatura','saldature'],
  ['bullonato','bullonata','bullonati','bullonate','bullone','bulloni','tirafondo','tirafondi'],
  ['soppalco','soppalchi','mezzanino','mezzanini'],
  ['passerella','passerelle','camminamento','camminamenti'],
  ['grigliato','grigliati','griglia','griglie'],
  ['porta','porte','portone','portoni','serramento','serramenti'],
  ['capannone','capannoni','industriale','struttura industriale']
];

function normalizeSearchText(value){
  return String(value||'')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function simpleStem(value){
  let s=normalizeSearchText(value);
  if(s.length<=4)return s;
  for(const suffix of ['azioni','zione','zioni','mente']){
    if(s.endsWith(suffix) && s.length-suffix.length>=4){
      return s.slice(0,-suffix.length);
    }
  }
  if(/[aeio]$/.test(s) && s.length>4)s=s.slice(0,-1);
  return s;
}

function levenshteinDistance(a,b){
  a=String(a||''); b=String(b||'');
  if(a===b)return 0;
  if(!a.length)return b.length;
  if(!b.length)return a.length;

  const prev=Array.from({length:b.length+1},(_,i)=>i);
  const curr=new Array(b.length+1);

  for(let i=1;i<=a.length;i++){
    curr[0]=i;
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      curr[j]=Math.min(curr[j-1]+1,prev[j]+1,prev[j-1]+cost);
    }
    for(let j=0;j<=b.length;j++)prev[j]=curr[j];
  }
  return prev[b.length];
}

function similarSearchTerm(a,b){
  const x=normalizeSearchText(a);
  const y=normalizeSearchText(b);
  if(!x||!y)return false;
  if(x===y)return true;
  if(x.includes(y)||y.includes(x))return true;

  const sx=simpleStem(x), sy=simpleStem(y);
  if(sx && sy && (sx===sy || sx.includes(sy) || sy.includes(sx)))return true;

  const maxLen=Math.max(x.length,y.length);
  if(maxLen>=5){
    const allowed=maxLen<=7?1:2;
    if(levenshteinDistance(x,y)<=allowed)return true;
  }
  return false;
}

function expandedSearchTerms(query){
  const q=normalizeSearchText(query);
  if(!q)return [];
  const words=q.split(' ').filter(Boolean);
  const result=new Set([q,...words]);

  for(const group of TAG_SEARCH_GROUPS){
    const normalizedGroup=group.map(normalizeSearchText);
    const groupMatches=normalizedGroup.some(term=>
      similarSearchTerm(q,term) ||
      words.some(word=>similarSearchTerm(word,term))
    );
    if(groupMatches)normalizedGroup.forEach(term=>result.add(term));
  }
  return [...result];
}

function photoMatchesSmartTagSearch(photo,query){
  const q=normalizeSearchText(query);
  if(!q)return true;

  const terms=expandedSearchTerms(q);
  const tags=[
    ...(photo?.tags||[]),
    ...(photo?.manualTags||[])
  ].map(normalizeSearchText).filter(Boolean);

  if(!tags.length)return false;
  return terms.some(term=>tags.some(tag=>similarSearchTerm(term,tag)));
}

function relatedTagNamesForQuery(query,allPhotos){
  const terms=expandedSearchTerms(query);
  if(!terms.length)return [];

  const allTags=[...new Set(
    (allPhotos||[])
      .flatMap(p=>[...(p.tags||[]),...(p.manualTags||[])])
      .map(normalizeSearchText)
      .filter(Boolean)
  )];

  return allTags
    .filter(tag=>terms.some(term=>similarSearchTerm(term,tag)))
    .slice(0,10);
}

async function renderTagGallery(){
  const all=await getUnifiedPhotos();

  const photos=all.filter(
    p=>{
      const exactFiltersMatch=
        [...activeTags].every(t=>(p.tags||[]).includes(t));

      const smartSearchMatch=
        photoMatchesSmartTagSearch(p,tagSearchQuery);

      return exactFiltersMatch && smartSearchMatch;
    }
  );

  const hint=$('tagSearchHint');
  if(hint){
    if(tagSearchQuery){
      const related=relatedTagNamesForQuery(tagSearchQuery,all);
      hint.textContent=
        photos.length
          ? `${photos.length} foto trovate${related.length?` · tag associati: ${related.join(', ')}`:''}`
          : `Nessuna foto trovata per "${tagSearchQuery}".`;
    }else{
      hint.textContent='Cerca liberamente: il sistema include automaticamente tag simili e correlati.';
    }
  }

  currentTagPhotos=photos;

  // Mantiene selezionate solo foto ancora visibili dopo il cambio filtro.
  if(tagSelectionMode){
    const visibleIds=new Set(
      photos.map(p=>String(p.id))
    );

    [...bulkSelectedIds].forEach(id=>{
      if(!visibleIds.has(String(id))){
        bulkSelectedIds.delete(String(id));
      }
    });
  }

  $('tagEmpty').classList.toggle(
    'hidden',
    photos.length>0
  );

  $('tagGallery').innerHTML=
    photos
      .map(
        p=>
          photoCardHTML(
            p,
            {
              selectable:tagSelectionMode,
              selected:bulkSelectedIds.has(String(p.id))
            }
          )
      )
      .join('');

  bindPhotoCards(
    $('tagGallery'),
    all,
    {
      selectionMode:tagSelectionMode
    }
  );

  updateBulkSelectionUI();
}



function visiblePhotoTags(tags){
  const normalized=normalizeTags(tags||[]);
  const placeholders=['da classificare','da-classificare','non classificato','non classificata','pending'];
  const real=normalized.filter(tag=>!placeholders.includes(String(tag).trim().toLowerCase()));
  return real.length ? real : normalized;
}

function photoCardHTML(p,options={}){
  p={...p,tags:visibleClassificationTags(p)};
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

  const selected=!!options.selected;
  const selector=options.selectable
    ? `<button type="button" class="photo-select-toggle ${selected?'selected':''}" data-select-photo-id="${escapeHtml(p.id)}" aria-label="Seleziona foto">${selected?'✓':'○'}</button>`
    : '';

  return `<button class="photo-card ${noGps?'no-gps':''} ${queueClass} ${selected?'bulk-selected':''}" data-id="${escapeHtml(p.id)}">
    <img src="${p.image}" alt="Foto cantiere">
    ${selector}
    ${queueLabel?`<span class="queue-photo-badge">${escapeHtml(queueLabel)}</span>`:''}
    <div class="overlay">${new Date(p.createdAt).toLocaleDateString('it-IT')}<br>${(p.tags||[]).slice(0,3).map(escapeHtml).join(' · ')}</div>
  </button>`;
}

function bindPhotoCards(host,all,options={}){
  host.querySelectorAll('.photo-select-toggle').forEach(toggle=>{
    toggle.onclick=e=>{
      e.preventDefault();
      e.stopPropagation();
      toggleBulkPhoto(toggle.dataset.selectPhotoId);
    };
  });

  host.querySelectorAll('.photo-card').forEach(card=>{
    card.onclick=e=>{
      if(e.target.closest('.photo-select-toggle'))return;
      if(options.selectionMode){
        toggleBulkPhoto(card.dataset.id);
        return;
      }
      openPhoto(card.dataset.id,all);
    };
  });
}

function openPhoto(id,all){
  const p=all.find(x=>String(x.id)===String(id)); if(!p)return;
  currentModalPhotoId=String(id); $('modalImg').src=p.image;
  const hasGps=p.lat!==null&&p.lng!==null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng));
  $('modalMeta').innerHTML=`<strong>${new Date(p.createdAt).toLocaleString('it-IT')}</strong><div class="muted">${p.dateSource?`Data: ${escapeHtml(p.dateSource)}<br>`:''}${hasGps?`GPS ${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)} · ±${Math.round(p.accuracy||0)} m${p.gpsSource?` · ${escapeHtml(p.gpsSource)}`:''}`:'Posizione non presente nel file selezionato'}</div><div class="tag-row">${(p.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>${p.aiSummary?`<div class="ai-summary">${escapeHtml(p.aiSummary)}</div>`:''}`;
  $('assignCurrentLocationBtn').classList.toggle('hidden',hasGps);
  renderManualTagEditor(p);
  if($('manualTagSaveStatus')){
    $('manualTagSaveStatus').textContent='';
    $('manualTagSaveStatus').classList.remove('ok','error');
  }
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
  const p=await resolvePhoto(photoId);
  if(!p)return;

  p.manualTags=
    Array.isArray(p.manualTags)
      ? p.manualTags
      : [];

  if(p.manualTags.includes(tag)){
    p.manualTags=
      p.manualTags.filter(
        x=>x!==tag
      );
  }else{
    p.manualTags=
      normalizeTags([
        ...p.manualTags,
        tag
      ]);
  }

  p.tags=
    mergeDisplayTags(
      p.tags,
      p.manualTags
    );

  // Salva il draft localmente nel record visualizzato;
  // il salvataggio Drive avviene col pulsante esplicito.
  const local=await getAllPhotos();
  const rec=local.find(
    x=>String(x.id)===String(photoId)
  );

  if(rec){
    rec.manualTags=p.manualTags||[];
    rec.tags=p.tags||[];
    await putPhoto(rec);
  }

  const status=$('manualTagSaveStatus');
  if(status){
    status.textContent='Modifiche da salvare';
    status.classList.remove('ok','error');
  }

  renderManualTagEditor(p);
  refreshModalMeta(p);
}


async function addCustomManualTag(){
  const raw=
    $('manualTagInput')
      .value
      .trim()
      .toLowerCase();

  if(
    !raw||
    currentModalPhotoId==null
  ){
    return;
  }

  const clean=
    raw
      .replace(/\s+/g,' ')
      .slice(0,30);

  const p=
    await resolvePhoto(
      currentModalPhotoId
    );

  if(!p)return;

  p.manualTags=
    normalizeTags([
      ...(p.manualTags||[]),
      clean
    ]);

  p.tags=
    mergeDisplayTags(
      p.tags,
      p.manualTags
    );

  const local=
    await getAllPhotos();

  const rec=
    local.find(
      x=>
        String(x.id)===
        String(currentModalPhotoId)
    );

  if(rec){
    rec.manualTags=p.manualTags||[];
    rec.tags=p.tags||[];
    await putPhoto(rec);
  }

  $('manualTagInput').value='';

  const status=$('manualTagSaveStatus');

  if(status){
    status.textContent='Modifiche da salvare';
    status.classList.remove('ok','error');
  }

  renderManualTagEditor(p);
  refreshModalMeta(p);
}


async function removeManualTag(photoId,tag){
  const p=await resolvePhoto(photoId);
  if(!p)return;

  p.manualTags=
    (p.manualTags||[])
      .filter(
        x=>x!==tag
      );

  p.tags=
    (p.tags||[])
      .filter(
        x=>x!==tag
      );

  const local=
    await getAllPhotos();

  const rec=
    local.find(
      x=>String(x.id)===String(photoId)
    );

  if(rec){
    rec.manualTags=p.manualTags||[];
    rec.tags=p.tags||[];
    await putPhoto(rec);
  }

  const status=$('manualTagSaveStatus');

  if(status){
    status.textContent='Modifiche da salvare';
    status.classList.remove('ok','error');
  }

  renderManualTagEditor(p);
  refreshModalMeta(p);
}


async function saveCurrentManualTags(){
  if(currentModalPhotoId==null){
    return;
  }

  const btn=$('saveManualTagsBtn');
  const status=$('manualTagSaveStatus');

  const oldText=btn?.textContent||'Salva tag manuali';

  if(btn){
    btn.disabled=true;
    btn.textContent='Salvataggio…';
  }

  if(status){
    status.textContent='';
    status.classList.remove('ok','error');
  }

  try{
    const p=await resolvePhoto(
      currentModalPhotoId
    );

    if(!p){
      throw new Error(
        'Foto non trovata.'
      );
    }

    /*
      Ricostruisce i tag visualizzati mantenendo
      quelli AI + quelli manuali scelti.
    */
    p.manualTags=normalizeTags(
      p.manualTags||[]
    );

    p.tags=mergeDisplayTags(
      p.tags,
      p.manualTags
    );

    p.tags=visiblePhotoTags(p.tags||[]);
    await persistManualTags(p);

    renderManualTagEditor(p);
    refreshModalMeta(p);
    await refreshVisibleViews();

    if(status){
      status.textContent='✓ Tag salvati';
      status.classList.add('ok');
    }

  }catch(err){

    console.error(
      'FM Foto salvataggio tag manuali:',
      err
    );

    if(status){
      status.textContent=
        `Errore: ${String(err?.message||err)}`;
      status.classList.add('error');
    }

  }finally{

    if(btn){
      btn.disabled=false;
      btn.textContent=oldText;
    }

  }
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
  setTimeout(()=>map.invalidateSize(),100);
  markersLayer.clearLayers();

  const groups=groupNearby(photos,25),bounds=[];
  groups.forEach(g=>{
    const lat=g.reduce((s,p)=>s+Number(p.lat),0)/g.length;
    const lng=g.reduce((s,p)=>s+Number(p.lng),0)/g.length;
    bounds.push([lat,lng]);
    const tags=[...new Set(g.flatMap(p=>p.tags||[]))].slice(0,8);
    const preview=g.slice(0,4).map(p=>`<img src="${p.image}" class="map-popup-thumb" alt="">`).join('');
    const marker=L.marker([lat,lng]).addTo(markersLayer).bindPopup(
      `<strong>${g.length} ${g.length===1?'foto':'foto'}</strong><br>${tags.map(escapeHtml).join(' · ')}<div class="map-popup-grid">${preview}</div><div class="map-popup-hint">Tocca il punto per vedere tutte le foto.</div>`
    );
    marker.on('click',()=>openMapLocationGroup(g,lat,lng));
  });

  if(bounds.length===1)map.setView(bounds[0],16);
  else if(bounds.length>1)map.fitBounds(bounds,{padding:[25,25]});
}

function openMapLocationGroup(group,lat,lng){
  currentMapGroup=[...group].sort((a,b)=>b.createdAt-a.createdAt);
  $('mapLocationTitle').textContent=`${currentMapGroup.length} foto in questa posizione`;
  $('mapLocationSub').textContent=`${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
  $('mapLocationPanel').classList.remove('hidden');
  renderMapLocationGroupCards();
  setTimeout(()=>$('mapLocationPanel').scrollIntoView({behavior:'smooth',block:'start'}),100);
}

function renderMapLocationGroupCards(){
  const host=$('mapLocationGallery');
  host.innerHTML=currentMapGroup.map(p=>photoCardHTML(p,{selectable:true,selected:bulkSelectedIds.has(String(p.id))})).join('');
  bindPhotoCards(host,currentMapGroup,{selectionMode:false});
  updateBulkSelectionUI();
}

function closeMapLocationGroup(){
  currentMapGroup=[];
  $('mapLocationPanel').classList.add('hidden');
  updateBulkSelectionUI();
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
