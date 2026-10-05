const CACHE='visitas-v1';
const CORE=['./','index.html','manifest.json','icon-192.png','icon-512.png'];
const CDN=['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js','https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js','https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    await Promise.allSettled([...CORE.map(u=>c.add(u)),...CDN.map(async u=>{const r=await fetch(u,{mode:'no-cors'});await c.put(u,r)})]);
    self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET')return;
  const sameOrigin=new URL(r.url).origin===self.location.origin;
  const cdn=CDN.includes(r.url);
  if(!sameOrigin&&!cdn)return;
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    if(cdn){
      const hit=await c.match(r.url);
      if(hit)return hit;
      const n=await fetch(r);c.put(r.url,n.clone());return n;
    }
    const fresh=fetch(r).then(n=>{if(n.ok)c.put(r,n.clone());return n});
    try{
      return await Promise.race([fresh,new Promise((_,rej)=>setTimeout(rej,3000))]);
    }catch(err){
      const hit=(await c.match(r,{ignoreSearch:true}))||(r.mode==='navigate'?await c.match('index.html'):null);
      return hit||Response.error();
    }
  })());
});
