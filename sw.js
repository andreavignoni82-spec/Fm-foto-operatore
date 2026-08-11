const CACHE='fm-foto-app-v7.7.4.1';
const CORE=['./','./index.html','./styles.css?v=7.7.4.1','./operator.css?v=7.7.4.1','./operator.js?v=7.7.4.1','./config.js?v=7.7.4.1','./manifest.webmanifest','./icon.svg','./admin.html'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
 caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('fm-foto-app-')&&k!==CACHE).map(k=>caches.delete(k)))),
 self.clients.claim()
])));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 e.respondWith(fetch(e.request).then(r=>{
   const copy=r.clone();
   caches.open(CACHE).then(c=>c.put(e.request,copy));
   return r;
 }).catch(()=>caches.match(e.request)));
});
