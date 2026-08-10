const CACHE='fm-foto-app-v6.0.0';
const CORE=['./','./index.html','./styles.css?v=6.0.0','./operator.css?v=6.0.0','./operator.js?v=6.0.0','./config.js?v=6.0.0','./manifest.webmanifest','./icon.svg','./admin.html'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('fm-foto-app-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
