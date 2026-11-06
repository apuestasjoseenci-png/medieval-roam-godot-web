/* Browser-only adapter. Coordinates stay in memory; no analytics or storage. */
(() => {
  'use strict';
  if (window.MedievalGPS) window.MedievalGPS.dispose();
  let callback = null, watch = null, generation = 0, disposed = false;
  let state = 'searching', permissionDenied = false;
  const button = document.createElement('button');
  button.id = 'activate-gps';
  button.textContent = 'Activar GPS';
  button.style.cssText = 'position:fixed;left:max(24px,env(safe-area-inset-left));top:120px;z-index:20;padding:12px 20px;min-height:48px;color:#fff0cc;background:#203b33;border:1px solid #d4b16f;border-radius:16px;font:16px sans-serif;touch-action:manipulation';
  button.setAttribute('aria-label', 'Activar GPS');
  document.body.appendChild(button);
  function emit(event) { if (!disposed && callback) callback(JSON.stringify(event)); }
  function status(next, detail) {
    state = next;
    emit({type:'state', state:next, detail});
    button.hidden = next === 'active' || next === 'paused';
    button.textContent = next === 'denied' ? 'Reintentar GPS' : 'Activar GPS';
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
    setFixAccepted(value) {
      if (value) { state = 'active'; button.hidden = true; }
      else { state = 'searching'; button.hidden = false; }
    },
    dispose() {
      stop(); disposed = true; callback = null;
      button.removeEventListener('click', request);
      button.remove();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', visibility);
    }
  };
})();
