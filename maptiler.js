/* Direct HTTPS MapTiler client. Personal session LRU only; never saves tiles. */
(function(root){
  'use strict';
  if(root.MedievalMap)root.MedievalMap.dispose();
  const V=root.MedievalVector;
  let callback=null,config=null,metadata=null,template='',last=null,disposed=false;
  let wanted=new Map(),queue=[],active=new Map(),cache=new Map(),rendered=new Map(),bytes=0,paused=false;
  let configPromise=null,authBlocked=false;
  const MAX_CACHE=8*1024*1024,MAX_ENTRIES=12,MAX_CONCURRENT=2,TTL=300000;
  const attribution=document.createElement('div');
  attribution.id='map-attribution';
  attribution.style.cssText='position:fixed;bottom:max(3px,env(safe-area-inset-bottom));left:8px;right:8px;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:8px;font:10px sans-serif;color:#fff;background:#172f29e8;border-radius:5px;padding:3px 6px';
  // Mandatory logo remains present for Free accounts. Text links are never collapsed.
  attribution.innerHTML='<a href="https://www.maptiler.com/" target="_blank" rel="noopener noreferrer"><img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" style="width:70px;height:20px"></a><span><a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer" style="color:inherit">© MapTiler</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style="color:inherit">© OpenStreetMap contributors</a></span>';
  document.body.appendChild(attribution);
  const extra=document.createElement('div');
  extra.id='map-source-attribution';extra.hidden=true;
  extra.style.cssText='position:fixed;bottom:32px;right:8px;z-index:30;font:10px sans-serif;background:#172f29e8;color:white;max-width:92vw;padding:3px';
  document.body.appendChild(extra);
  function emit(event){if(!disposed&&callback)callback(JSON.stringify(event));}
  function status(state,detail){attribution.dataset.state=state;emit({type:'status',state,detail});}
  async function bounded(url,controller,limit){
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(url,{signal:controller.signal,mode:'cors',credentials:'omit',referrerPolicy:'strict-origin-when-cross-origin'});
      if(!response.ok){
        const err=new Error('HTTP '+response.status);err.code=response.status;throw err;
      }
      const control=response.headers.get('cache-control')||'';
      const age=control.match(/(?:^|,)\s*max-age=(\d+)/i);
      const cacheMS=/no-store|no-cache/i.test(control)?0:Math.min(TTL,age?Number(age[1])*1000:TTL);
      const mark=b=>{b.cacheMS=cacheMS;return b;};
      if(response.status===204)return mark(new Uint8Array());
      const declared=Number(response.headers.get('content-length'));
      if(declared>limit)throw Error('Respuesta demasiado grande');
      if(!response.body?.getReader){const b=new Uint8Array(await response.arrayBuffer());if(b.length>limit)throw Error('Respuesta demasiado grande');return mark(b);}
      const reader=response.body.getReader(),chunks=[];let total=0;
      for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw Error('Respuesta demasiado grande');}chunks.push(value);}
      const out=new Uint8Array(total);let offset=0;for(const part of chunks){out.set(part,offset);offset+=part.length;}return mark(out);
    }finally{clearTimeout(timer);}
  }
  function showAttribution(html){
    // TileJSON is not trusted HTML. Preserve only sanitized linked text.
    const parsed=new DOMParser().parseFromString(String(html||''),'text/html');
    extra.replaceChildren();
    for(const node of parsed.body.childNodes){
      if(node.nodeType===3)extra.appendChild(document.createTextNode(node.textContent));
      else if(node.nodeType===1){
        const a=document.createElement('a'),url=node.getAttribute('href')||'';
        if(/^https:\/\//.test(url)){a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.style.color='inherit';a.textContent=node.textContent;extra.appendChild(a);}
        else extra.appendChild(document.createTextNode(node.textContent));
      }
    }
    // Baseline providers already have persistent links in the bottom bar.
    extra.hidden=!String(html).replace(/<[^>]+>/g,'').trim()||/^(?:[©\s|·]|MapTiler|OpenStreetMap|contributors)+$/i.test(parsed.body.textContent);
  }
  async function configure(){
    if(configPromise)return configPromise;
    configPromise=(async()=>{
      status('loading','Cargando configuración del mapa');
      const cfgBytes=await bounded(new URL('maptiler-config.json',document.baseURI),new AbortController(),4096);
      config=JSON.parse(new TextDecoder().decode(cfgBytes));
      if(typeof config.apiKey!=='string'||!/^[a-zA-Z0-9_-]{10,100}$/.test(config.apiKey)||!/^v[34]$/.test(config.tileset||''))throw Error('Configura la clave pública de MapTiler');
      const metaBytes=await bounded('https://api.maptiler.com/tiles/'+config.tileset+'/tiles.json?key='+encodeURIComponent(config.apiKey),new AbortController(),1024*1024);
      const meta=JSON.parse(new TextDecoder().decode(metaBytes));
      if(meta.format!=='pbf'||meta.scheme==='tms'||!Array.isArray(meta.vector_layers)||!meta.vector_layers.some(l=>l.id==='transportation'))throw Error('Esquema MapTiler no compatible: se requiere transportation MVT');
      template=meta.tiles?.find(t=>/^https:\/\/api\.maptiler\.com\/tiles\//.test(t)&&t.includes('{z}')&&t.includes('{x}')&&t.includes('{y}'));
      if(!template)throw Error('TileJSON no proporciona una URL MVT HTTPS válida');
      metadata={zoom:Math.max(0,Math.min(16,Number(meta.maxzoom)||14))};
      showAttribution(meta.attribution);
      return true;
    })().catch(error=>{
      if(disposed)return false;
      authBlocked=error.code===401||error.code===403;
      status(authBlocked?'error':'unconfigured',authBlocked?'MapTiler: clave o dominio no autorizado (403)':'Mapa no disponible · revisa configuración o conexión');
      configPromise=null;return false;
    });
    return configPromise;
  }
  function key(t){return t.join('/');}
  function removeExpired(){
    const now=Date.now();
    for(const [k,item] of cache)if(now-item.time>item.ttl&&!wanted.has(k)){bytes-=item.bytes;cache.delete(k);}
    while(cache.size>MAX_ENTRIES||bytes>MAX_CACHE){
      const candidate=[...cache.keys()].find(k=>!wanted.has(k))||cache.keys().next().value;
      const item=cache.get(candidate);bytes-=item.bytes;cache.delete(candidate);
    }
  }
  function deliver(k,tile,item){
    emit({type:'tile',id:k,tile,roads:item.roads,bounds:[V.lonLat(tile[0],tile[1],tile[2]),V.lonLat(tile[0]+1,tile[1]+1,tile[2])]});
  }
  function plan(){
    if(disposed||paused||!metadata||!last)return;
    const list=V.sectors(last[0],last[1],metadata.zoom);
    wanted=new Map(list.map(t=>[key(t),t]));
    for(const k of rendered.keys())if(!wanted.has(k))rendered.delete(k);
    emit({type:'wanted',ids:[...wanted.keys()]});
    for(const [k,job]of active)if(!wanted.has(k)){job.controller.abort();active.delete(k);}
    queue=[];
    for(const [k,tile]of wanted){
      const item=cache.get(k);
      if(item&&Date.now()-item.time<item.ttl){cache.delete(k);cache.set(k,item);deliver(k,tile,item);}
      else if(!active.has(k))queue.push([k,tile]);
    }
    removeExpired();
    pump();
  }
  function pump(){
    if(disposed||paused||authBlocked)return;
    while(active.size<MAX_CONCURRENT&&queue.length){
      const [k,tile]=queue.shift();const controller=new AbortController(),job={controller};active.set(k,job);
      (async()=>{
        status('loading','Cargando calles y caminos');
        let url=template.replace('{z}',tile[2]).replace('{x}',tile[0]).replace('{y}',tile[1]);
        if(!new URL(url).searchParams.has('key'))url+=(url.includes('?')?'&':'?')+'key='+encodeURIComponent(config.apiKey);
        const data=await bounded(url,controller,V.MAX_BYTES);
        if(disposed||controller.signal.aborted||!wanted.has(k))return;
        // Yield to the GPS/UI event loop before bounded protobuf work.
        await new Promise(resolve=>setTimeout(resolve,0));
        if(disposed||controller.signal.aborted||!wanted.has(k))return;
        const roads=V.geographic(V.decode(data),tile);
        let points=0;for(const road of roads)points+=road.points.length;
        const item={roads,time:Date.now(),ttl:data.cacheMS??TTL,bytes:points*112+roads.length*400+512};
        if(cache.has(k))bytes-=cache.get(k).bytes;
        cache.delete(k);if(item.ttl>0){cache.set(k,item);bytes+=item.bytes;}
        removeExpired();deliver(k,tile,item);
      })().catch(error=>{
        if(disposed||controller.signal.aborted)return;
        if(error.code===401||error.code===403){authBlocked=true;queue=[];}
        emit({type:'tile_error',id:k});
        status('error',authBlocked?'MapTiler: clave o dominio no autorizado':'Mapa sin conexión o tesela inválida · GPS sigue activo');
      }).finally(()=>{
        if(active.get(k)===job)active.delete(k);
        if(disposed)return;
        pump();
        if(!active.size&&!queue.length&&!authBlocked&&[...wanted.keys()].every(id=>rendered.has(id)))status('ready','Mapa actualizado');
      });
    }
  }
  function visibility(){
    paused=document.hidden;
    if(paused){for(const job of active.values())job.controller.abort();active.clear();queue=[];}
    else if(last&&!authBlocked)update(...last);
  }
  async function update(lat,lon){
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85.05112878){status('error','Mapa fuera de cobertura Mercator');return;}
    last=[lat,lon];
    if(disposed||paused||authBlocked)return;
    if(await configure())plan();
  }
  document.addEventListener('visibilitychange',visibility);
  root.MedievalMap={
    connectGodot(fn){callback=fn;status('waiting','Mapa: esperando ubicación GPS');},
    update,
    retry(){authBlocked=false;metadata=null;configPromise=null;if(last)update(...last);},
    dispose(){disposed=true;for(const job of active.values())job.controller.abort();active.clear();queue=[];cache.clear();bytes=0;callback=null;attribution.remove();extra.remove();document.removeEventListener('visibilitychange',visibility);},
    sectorRendered(id,segments,decorations){
      if(wanted.has(id))rendered.set(id,{segments,decorations});
      if(!active.size&&!queue.length&&!authBlocked&&[...wanted.keys()].every(k=>rendered.has(k)))status('ready','Mapa actualizado');
    },
    stats(){return {active:active.size,cached:cache.size,bytes,wanted:wanted.size,rendered:rendered.size,segments:[...rendered.values()].reduce((n,s)=>n+s.segments,0)};}
  };
})(globalThis);
