/* Browser-only adapter. Coordinates stay in memory; no analytics or storage. */
(() => {
  'use strict';
  if (window.MedievalGPS) window.MedievalGPS.dispose();
  let callback = null, watch = null, generation = 0, disposed = false;
  let state = 'searching', permissionDenied = false;
  const button = document.createElement('button');
  button.id = 'activate-gps';
  button.textContent = 'Activar GPS';
  button.style.cssText = 'position:fixed;left:max(16px,env(safe-area-inset-left));top:var(--medieval-gps-top,140px);box-sizing:border-box;max-width:calc(100vw - 112px);z-index:20;padding:12px 20px;min-height:48px;color:#fff0cc;background:#203b33;border:1px solid #d4b16f;border-radius:16px;font:16px sans-serif;touch-action:manipulation';
  button.setAttribute('aria-label', 'Activar GPS');
  document.body.appendChild(button);
  const notice=document.createElement('div');notice.id='combat-gps-status';notice.setAttribute('role','status');
  notice.style.cssText='position:fixed;z-index:20;pointer-events:none;box-sizing:border-box;padding:3px 6px;border-radius:5px;background:#172f29e8;color:#fff0cc;font:12px sans-serif;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform-origin:top left';
  document.body.appendChild(notice);
  let presentation={map:true,combat:false,top:140,notice:640,w:390,h:844};
  function present(){
    const p=presentation,c=document.querySelector('#canvas'),r=c?.getBoundingClientRect();
    button.hidden=!p.map||state==='active'||state==='paused';
    notice.hidden=!p.combat||state==='active'||state==='paused';
    notice.textContent='GPS pendiente · el combate continúa';
    if(!r)return;
    const scale=r.width/p.w;
    Object.assign(button.style,{left:(r.left+16*scale)+'px',top:(r.top+p.top*r.height/p.h)+'px',maxWidth:(p.w-32)+'px',transform:'scale('+scale+')',transformOrigin:'top left'});
    Object.assign(notice.style,{left:(r.left+16*scale)+'px',top:(r.top+p.notice*r.height/p.h)+'px',width:(p.w-32)+'px',transform:'scale('+scale+')'});
  }
  window.addEventListener('resize',present);
  window.visualViewport?.addEventListener('resize',present);
  function emit(event) { if (!disposed && callback) callback(JSON.stringify(event)); }
  function status(next, detail) {
    state = next;
    emit({type:'state', state:next, detail});
    button.hidden = next === 'active' || next === 'paused';
    button.textContent = next === 'denied' ? 'Reintentar GPS' : 'Activar GPS';
    present();
  }
  function stop() {
    generation++;
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
  }
  function request() {
    if (disposed) return;
    stop();
    permissionDenied = false;
    if (!window.isSecureContext) { status('error', 'GPS requiere HTTPS'); return; }
    if (!navigator.geolocation) { status('error', 'Ubicación no disponible en este navegador'); return; }
    if (document.hidden) { status('paused', 'GPS en pausa'); return; }
    const epoch = generation;
    status('searching', 'Buscando GPS · permite el acceso a ubicación');
    try {
      watch = navigator.geolocation.watchPosition(position => {
        if (disposed || epoch !== generation) return;
        const c = position.coords;
        emit({type:'fix', latitude:c.latitude, longitude:c.longitude, accuracy:c.accuracy, timestamp:position.timestamp});
      }, error => {
        if (disposed || epoch !== generation) return;
        if (error.code === 1) {
          permissionDenied = true;
          stop();
          status('denied', 'Permiso denegado · revisa los ajustes de Safari');
        } else {
          status('error', error.code === 3 ? 'Sin señal GPS · tiempo agotado' : 'Ubicación no disponible');
        }
      }, {enableHighAccuracy:true, maximumAge:0, timeout:15000});
    } catch (_) {
      stop();
      status('error', 'No se pudo activar GPS · pulsa Activar GPS');
    }
  }
  function visibility() {
    if (document.hidden) { stop(); status('paused', 'GPS en pausa · vuelve al juego'); }
    else if (!permissionDenied) request();
    else status('denied', 'Permiso denegado · revisa los ajustes de Safari');
  }
  // A native DOM click calls watchPosition synchronously within user activation.
  button.addEventListener('click', request);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', visibility);
  window.MedievalGPS = {
    connectGodot(fn) { callback = fn; request(); },
    request,
    getButtonRect(){
      if(button.hidden)return null;
      const c=document.querySelector('#canvas')?.getBoundingClientRect(),r=button.getBoundingClientRect();
      if(!c||!c.width||!c.height||!r.width||!r.height)return null;
      return [(r.x-c.x)*presentation.w/c.width,(r.y-c.y)*presentation.h/c.height,r.width*presentation.w/c.width,r.height*presentation.h/c.height];
    },
    setPresentation(map,combat,top,notice,w,h){presentation={map,combat,top,notice,w,h};present();},
    setFixAccepted(value) {
      if (value) { state = 'active'; button.hidden = true; }
      else { state = 'searching'; button.hidden = false; }
      present();
    },
    dispose() {
      stop(); disposed = true; callback = null;
      button.removeEventListener('click', request);
      button.remove();
      notice.remove();
      window.removeEventListener('resize',present);
      window.visualViewport?.removeEventListener('resize',present);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', visibility);
    }
  };
})();
