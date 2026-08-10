const MODEL="@cf/meta/llama-3.2-11b-vision-instruct";
const ALLOWED_ORIGIN="https://andreavignoni82-spec.github.io";

function cors(){
  return {
    "Access-Control-Allow-Origin":ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Max-Age":"86400"
  };
}

function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      ...cors()
    }
  });
}

function parseJSON(text){
  if(typeof text==="object"&&text!==null)return text;
  const clean=String(text||"").replace(/```json/gi,"").replace(/```/g,"").trim();
  try{return JSON.parse(clean)}catch{}
  const m=clean.match(/\{[\s\S]*\}/);
  if(!m)return null;
  try{return JSON.parse(m[0])}catch{return null}
}

function dataUrlToBlob(dataUrl){
  const [head,b64]=dataUrl.split(",");
  const mime=(head.match(/:(.*?);/)||[])[1]||"image/jpeg";
  const bin=atob(b64);
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return new Blob([bytes],{type:mime});
}

async function googleAccessToken(env){
  const body=new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,
    client_secret:env.GOOGLE_CLIENT_SECRET,
    refresh_token:env.GOOGLE_REFRESH_TOKEN,
    grant_type:"refresh_token"
  });

  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });

  const j=await r.json();

  if(!r.ok||!j.access_token){
    throw new Error(`Google token: ${j.error_description||j.error||r.status}`);
  }

  return j.access_token;
}

async function driveRequest(token,url,options={}){
  const r=await fetch(url,{
    ...options,
    headers:{
      ...(options.headers||{}),
      Authorization:`Bearer ${token}`
    }
  });

  if(!r.ok){
    throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0,300)}`);
  }

  return r;
}

async function ensureFolder(token,name,parentId){
  const safe=String(name).replaceAll("'","\\'");
  const q=encodeURIComponent(
    `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );

  let r=await driveRequest(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`
  );

  let j=await r.json();

  if(j.files?.[0])return j.files[0].id;

  r=await driveRequest(
    token,
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        name,
        mimeType:"application/vnd.google-apps.folder",
        parents:[parentId]
      })
    }
  );

  return (await r.json()).id;
}

async function ensureDateFolder(token,rootId,capturedAt){
  const d=new Date(capturedAt||Date.now());
  const fm=await ensureFolder(token,"FM_FOTO",rootId);
  const year=await ensureFolder(token,String(d.getFullYear()),fm);
  return ensureFolder(token,String(d.getMonth()+1).padStart(2,"0"),year);
}

async function uploadPhoto(token,rootId,input,classification){
  const folderId=await ensureDateFolder(token,rootId,input.capturedAt);

  const blob=dataUrlToBlob(input.image);
  const d=new Date(input.capturedAt||Date.now());

  const name=[
    "FMFOTO",
    `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`,
    `${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`,
    String(input.localId||Date.now())
  ].join("_")+".jpg";

  const metadata={
    name,
    parents:[folderId],
    description:
      `FM foto | GPS ${input.lat}, ${input.lng} | `+
      `tags: ${(classification.tags||[]).join(", ")} | `+
      `${classification.summary||""}`,
    appProperties:{
      fmfoto:"1",
      localId:String(input.localId||""),
      lat:String(input.lat??""),
      lng:String(input.lng??""),
      capturedAt:String(input.capturedAt??""),
      tags:(classification.tags||[]).join("|"),
      manualTags:(input.manualTags||[]).join("|"),
      summary:String(classification.summary||"").slice(0,120),
      accuracy:String(input.accuracy??""),
      source:String(input.source||"camera")
    }
  };

  const boundary="fmfoto_"+crypto.randomUUID();

  const multipart=new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`
  ],{
    type:`multipart/related; boundary=${boundary}`
  });

  const r=await driveRequest(
    token,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method:"POST",
      headers:{
        "Content-Type":`multipart/related; boundary=${boundary}`
      },
      body:multipart
    }
  );

  return r.json();
}

async function classify(env,input){
  const allowedTags=Array.isArray(input.allowedTags)?input.allowedTags:[];

  const prompt=`
Sei il classificatore visuale di FM foto.
Analizza l'immagine in modo generale e preciso. NON sei limitato alla carpenteria.
Puoi riconoscere qualunque oggetto, materiale, ambiente, edificio, impianto, mezzo, attrezzatura, arredo, elemento naturale o dettaglio visibile.

Genera tag su più livelli: categoria generale, oggetto specifico, materiale, finitura/colore se riconoscibile, funzione/uso, ambiente/contesto, stato, stile o caratteristica distintiva.

Esempi: recinzione + recinzione in lamiera + lamiera + acciaio + verniciato + nero + esterno; recinzione + recinzione inox + inox + satinato + esterno; cancello + cancello carrabile + automazione + acciaio + verniciato; serramento + finestra + alluminio + vetro; impianto elettrico + quadro elettrico; veicolo + automobile + SUV; arredo + tavolo + legno.

Vocabolario suggerito, NON vincolante:
${allowedTags.join(", ")}

Puoi creare tag nuovi se descrivono meglio ciò che è visibile. Evita sinonimi inutilmente duplicati. Genera da 4 a 14 tag quando l'immagine lo consente. Non inventare materiale, finitura o funzione se non sono ragionevolmente riconoscibili.
summary: descrizione in italiano, massimo 25 parole. confidence: numero da 0 a 1.
Rispondi esclusivamente in JSON valido:
{"tags":["..."],"confidence":0.85,"summary":"..."}
`;

  const result=await env.AI.run(MODEL,{
    prompt,
    image:String(input.image),
    max_tokens:240,
    temperature:0.1
  });

  const parsed=parseJSON(result?.response??result);

  if(!parsed){
    throw new Error("Risposta AI non interpretabile");
  }

  return {
    tags:[...new Set(
      (parsed.tags||[])
        .map(x=>String(x).trim().toLowerCase())
        .filter(Boolean)
    )].slice(0,14),
    confidence:Math.max(0,Math.min(1,Number(parsed.confidence)||0)),
    summary:String(parsed.summary||"").trim().slice(0,280)
  };
}


async function listArchive(token,env){
  const q=encodeURIComponent("appProperties has { key='fmfoto' and value='1' } and trashed=false");
  let pageToken="",files=[];
  do{
    const url="https://www.googleapis.com/drive/v3/files"+
      `?q=${q}&spaces=drive&pageSize=1000&orderBy=createdTime desc&fields=nextPageToken,files(id,name,createdTime,modifiedTime,description,appProperties)`+
      (pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:"");
    const r=await driveRequest(token,url),j=await r.json();
    files.push(...(j.files||[])); pageToken=j.nextPageToken||"";
  }while(pageToken);

  return files.map(f=>{
    const ap=f.appProperties||{};
    return {
      driveFileId:f.id,name:f.name,createdTime:f.createdTime,
      capturedAt:Number(ap.capturedAt)||Date.parse(f.createdTime)||0,
      lat:(ap.lat===""||typeof ap.lat==="undefined")?null:Number(ap.lat),
      lng:(ap.lng===""||typeof ap.lng==="undefined")?null:Number(ap.lng),accuracy:Number(ap.accuracy)||0,
      tags:(ap.tags||"").split("|").map(x=>x.trim()).filter(Boolean),
      manualTags:(ap.manualTags||"").split("|").map(x=>x.trim()).filter(Boolean),
      summary:ap.summary||"",
      source:ap.source||"camera",
      photoUrl:`${env.PUBLIC_BASE_URL}/photo?id=${encodeURIComponent(f.id)}`
    };
  });
}
async function proxyPhoto(token,fileId){
  const r=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  const h=new Headers({"Content-Type":r.headers.get("Content-Type")||"image/jpeg","Cache-Control":"public, max-age=3600","Access-Control-Allow-Origin":ALLOWED_ORIGIN});
  return new Response(r.body,{status:200,headers:h});
}
async function updateDriveTags(token,fileId,manualTags){
  const metaRes=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,description,appProperties`);
  const file=await metaRes.json(),ap=file.appProperties||{};
  const existing=(ap.tags||"").split("|").map(x=>x.trim()).filter(Boolean);
  const oldManual=(ap.manualTags||"").split("|").map(x=>x.trim()).filter(Boolean);
  const aiTags=existing.filter(t=>!oldManual.includes(t));
  const cleaned=[...new Set((manualTags||[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,20);
  const tags=[...new Set([...aiTags,...cleaned])].slice(0,30);
  const patch={appProperties:{...ap,tags:tags.join("|"),manualTags:cleaned.join("|")}};
  const r=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`,{
    method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)
  });
  await r.json(); return {tags,manualTags:cleaned};
}


async function updateDriveLocation(token,fileId,lat,lng,accuracy){
  const metaRes=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`);
  const file=await metaRes.json(),ap=file.appProperties||{};
  const patch={appProperties:{...ap,lat:String(lat),lng:String(lng),accuracy:String(accuracy||0)}};
  const r=await driveRequest(token,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,appProperties`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)});
  await r.json(); return {lat:Number(lat),lng:Number(lng),accuracy:Number(accuracy)||0};
}

export default{
  async fetch(request,env){
    if(request.method==="OPTIONS"){
      return new Response(null,{status:204,headers:cors()});
    }

    const url=new URL(request.url);

    if(request.method==="GET"&&url.pathname==="/"){
      return json({
        service:"FM foto backend",
        status:"online",
        version:"2.6",
        ai:true,
        driveBackend:true,
        config:{
          clientId:!!env.GOOGLE_CLIENT_ID,
          clientSecret:!!env.GOOGLE_CLIENT_SECRET,
          refreshToken:!!env.GOOGLE_REFRESH_TOKEN,
          driveFolder:!!env.GOOGLE_DRIVE_FOLDER_ID
        }
      });
    }

    if(request.method==="GET"&&url.pathname==="/drive-test"){
      try{
        const token=await googleAccessToken(env);
        const r=await driveRequest(
          token,
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(env.GOOGLE_DRIVE_FOLDER_ID)}?fields=id,name,mimeType,trashed`
        );
        const folder=await r.json();

        return json({
          ok:true,
          drive:true,
          folder
        });
      }catch(err){
        return json({
          ok:false,
          error:"DRIVE_TEST_FAILED",
          message:String(err?.message||err)
        },500);
      }
    }

    if(request.method==="GET"&&url.pathname==="/archive"){
      try{
        const token=await googleAccessToken(env);
        const photos=await listArchive(token,{...env,PUBLIC_BASE_URL:`${url.protocol}//${url.host}`});
        return json({ok:true,photos});
      }catch(err){
        return json({ok:false,error:"ARCHIVE_FAILED",message:String(err?.message||err)},500);
      }
    }

    if(request.method==="GET"&&url.pathname==="/photo"){
      try{
        const id=url.searchParams.get("id");
        if(!id)return json({ok:false,error:"MISSING_ID"},400);
        const token=await googleAccessToken(env);
        return await proxyPhoto(token,id);
      }catch(err){
        return json({ok:false,error:"PHOTO_FAILED",message:String(err?.message||err)},500);
      }
    }

    if(request.method==="POST"&&url.pathname==="/update-tags"){
      try{
        const input=await request.json();
        if(!input.driveFileId)return json({ok:false,error:"MISSING_FILE_ID"},400);
        const token=await googleAccessToken(env);
        const result=await updateDriveTags(token,input.driveFileId,Array.isArray(input.manualTags)?input.manualTags:[]);
        return json({ok:true,...result});
      }catch(err){
        return json({ok:false,error:"UPDATE_TAGS_FAILED",message:String(err?.message||err)},500);
      }
    }

    if(request.method==="POST"&&url.pathname==="/update-location"){
      try{
        const input=await request.json(); if(!input.driveFileId)return json({ok:false,error:"MISSING_FILE_ID"},400);
        if(!Number.isFinite(Number(input.lat))||!Number.isFinite(Number(input.lng)))return json({ok:false,error:"INVALID_LOCATION"},400);
        const token=await googleAccessToken(env);
        const result=await updateDriveLocation(token,input.driveFileId,Number(input.lat),Number(input.lng),Number(input.accuracy)||0);
        return json({ok:true,...result});
      }catch(err){return json({ok:false,error:"UPDATE_LOCATION_FAILED",message:String(err?.message||err)},500);}
    }

    if(request.method!=="POST"||url.pathname!=="/process"){
      return json({error:"not_found"},404);
    }

    try{
      if(!env.GOOGLE_CLIENT_ID ||
         !env.GOOGLE_CLIENT_SECRET ||
         !env.GOOGLE_REFRESH_TOKEN ||
         !env.GOOGLE_DRIVE_FOLDER_ID){
        return json({
          ok:false,
          error:"BACKEND_NOT_CONFIGURED",
          message:"Mancano una o più variabili Google nel Worker."
        },500);
      }

      const input=await request.json();

      if(!input.image||!String(input.image).startsWith("data:image/")){
        return json({ok:false,error:"INVALID_IMAGE"},400);
      }

      const classification=await classify(env,input);

      if(Array.isArray(input.manualTags)){
        classification.tags=[...new Set([
          ...(classification.tags||[]),
          ...input.manualTags.map(x=>String(x).trim().toLowerCase()).filter(Boolean)
        ])].slice(0,12);
      }

      const token=await googleAccessToken(env);

      const uploaded=await uploadPhoto(
        token,
        env.GOOGLE_DRIVE_FOLDER_ID,
        input,
        classification
      );

      return json({
        ok:true,
        ...classification,
        driveUploaded:true,
        driveFileId:uploaded.id||"",
        driveFileName:uploaded.name||""
      });

    }catch(err){
      console.error("FM FOTO BACKEND",err);

      return json({
        ok:false,
        error:"PROCESS_FAILED",
        message:String(err?.message||err)
      },500);
    }
  }
};
