'use strict';

// Cámaras en la mesa de blackjack (solo vídeo) con WebRTC entre navegadores.
// El servidor solo reenvía la señalización (rtc:signal); el vídeo va de navegador a
// navegador. Quien se sienta y activa la cámara la emite; cada espectador de la mesa
// le pide el vídeo ("want") y el emisor le responde con una oferta.
window.CameraUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const MAX_VIEWERS = 20; // cada espectador es una subida más para el emisor
  const MAX_BITRATE = 250_000;
  const RETRY_MS = 4_000;
  const MAX_RETRIES = 3;
  const VIDEO = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' };

  let ctx;
  let modal;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null;
  let starting = false;
  const sending = new Map(); // socket del espectador -> RTCPeerConnection
  const receiving = new Map(); // socket del emisor -> { pc, userId, stream, pending, retries, timer }
  const videos = new Map(); // userId -> <video> (persistente entre renders de la mesa)

  const send = (to, kind, extra = {}) => ctx.socket.emit('rtc:signal', { to, kind, ...extra });

  function videoEl(userId) {
    let video = videos.get(userId);
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.muted = true; // no hay audio, y así el navegador permite reproducir solo
      video.playsInline = true;
      // WebRTC entrega primero un fotograma vacío de 2×2: se muestra el vídeo solo cuando
      // llegan fotogramas reales (mientras, se ve la foto del jugador debajo).
      const markLive = () => video.classList.toggle('live', video.videoWidth > 16);
      for (const event of ['loadeddata', 'resize', 'playing']) video.addEventListener(event, markLive);
      videos.set(userId, video);
    }
    return video;
  }

  function dropVideo(userId) {
    const video = videos.get(userId);
    if (!video) return;
    video.srcObject = null;
    video.remove();
    videos.delete(userId);
  }

  function errorMessage(err) {
    if (!window.isSecureContext) return 'La cámara solo funciona en una conexión segura (HTTPS).';
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError': return 'No diste permiso para usar la cámara. Puedes activarlo en el candado de la barra de direcciones.';
      // P. ej. navegadores dentro de otras apps (Instagram, TikTok…), que no dan acceso a la cámara.
      case 'NotSupportedError': return 'Este navegador no permite usar la cámara aquí. Prueba con Chrome, Safari o Firefox.';
      case 'NotFoundError': return 'No se encontró ninguna cámara.';
      case 'NotReadableError': return 'La cámara está siendo usada por otra aplicación.';
      default: return 'No se pudo activar la cámara.';
    }
  }

  // ---------- emitir mi cámara ----------

  async function start() {
    if (localStream || starting) return;
    if (!navigator.mediaDevices?.getUserMedia) return ctx.toast(errorMessage(), 'error');
    starting = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
      const res = await ctx.emit('bj:camera', { on: true });
      if (!res.ok) {
        stopTracks();
        return ctx.toast(res.error, 'error');
      }
      // Si se desconecta la cámara (se cierra la tapa, se quita el permiso…), se apaga.
      localStream.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      ctx.toast('Cámara activada: te ven en tu asiento', 'success');
    } catch (err) {
      stopTracks();
      ctx.toast(errorMessage(err), 'error');
    } finally {
      starting = false;
      changed();
    }
  }

  function stopTracks() {
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    dropVideo(ctx.user.id);
  }

  /** Apaga mi cámara. `notify: false` cuando ya no estoy sentado (el servidor ya lo sabe). */
  function stop({ notify = true } = {}) {
    if (!localStream) return;
    stopTracks();
    for (const pc of sending.values()) pc.close();
    sending.clear();
    if (notify) ctx.emit('bj:camera', { on: false });
    changed();
  }

  async function onWant(viewer) {
    if (!localStream || sending.size >= MAX_VIEWERS) return send(viewer, 'bye');
    sending.get(viewer)?.close();
    const pc = new RTCPeerConnection({ iceServers });
    sending.set(viewer, pc);
    for (const track of localStream.getVideoTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => e.candidate && send(viewer, 'candidate', { candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && sending.get(viewer) === pc) {
        pc.close();
        sending.delete(viewer);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    // Calidad baja a propósito: con la mesa llena hay muchas cámaras a la vez.
    for (const sender of pc.getSenders()) {
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: MAX_BITRATE }];
      await sender.setParameters(params).catch(() => {});
    }
    send(viewer, 'offer', { sdp: pc.localDescription.sdp });
  }

  // ---------- ver las cámaras de los demás ----------

  function closeReceiving(peer, { keepVideo = false } = {}) {
    const entry = receiving.get(peer);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.pc?.close();
    receiving.delete(peer);
    if (!keepVideo) dropVideo(entry.userId);
  }

  function request(peer, userId, retries = 0) {
    const pc = new RTCPeerConnection({ iceServers });
    const entry = { pc, userId, pending: [], retries, timer: null };
    receiving.set(peer, entry);
    pc.onicecandidate = (e) => e.candidate && send(peer, 'candidate', { candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const video = videoEl(userId);
      video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' || receiving.get(peer) !== entry) return;
      // Reintenta unas veces por si fue un corte momentáneo de red.
      pc.close();
      if (entry.retries >= MAX_RETRIES) return;
      entry.timer = setTimeout(() => {
        if (receiving.get(peer) === entry) request(peer, userId, entry.retries + 1);
      }, RETRY_MS);
    };
    send(peer, 'want');
  }

  async function onSignal({ from, kind, sdp, candidate }) {
    try {
      if (kind === 'want') return await onWant(from);
      if (kind === 'bye') return closeReceiving(from);
      if (kind === 'answer') return await sending.get(from)?.setRemoteDescription({ type: 'answer', sdp });

      const entry = receiving.get(from);
      if (kind === 'offer' && entry) {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp });
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        send(from, 'answer', { sdp: entry.pc.localDescription.sdp });
        for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
      } else if (kind === 'candidate') {
        // Un candidato puede llegar antes que la oferta: se guarda hasta tenerla.
        if (entry && !entry.pc.remoteDescription) entry.pending.push(candidate);
        else await (entry?.pc ?? sending.get(from))?.addIceCandidate(candidate).catch(() => {});
      }
    } catch (err) {
      console.warn('[cámara]', kind, err);
    }
  }

  /**
   * Se llama en cada render de la mesa: pide el vídeo de las cámaras nuevas y
   * cierra las que ya no están.
   */
  function sync(state) {
    const wanted = new Map();
    for (const seat of state?.seats ?? []) {
      if (seat?.camera && seat.cameraPeer && seat.cameraPeer !== ctx.socket.id) wanted.set(seat.cameraPeer, seat.userId);
    }
    for (const peer of [...receiving.keys()]) if (!wanted.has(peer)) closeReceiving(peer);
    for (const [peer, userId] of wanted) if (!receiving.has(peer)) request(peer, userId);
  }

  /** Al cambiar de mesa: deja de ver las cámaras de la anterior (la mía sigue emitiendo). */
  function resetViewing() {
    for (const peer of [...receiving.keys()]) closeReceiving(peer);
  }

  /** Recuadro de vídeo para una silla, o null si esa silla no tiene cámara. */
  function mount(seat, mine) {
    if (!seat.camera) return null;
    const box = document.createElement('div');
    box.className = 'seat-cam';
    // La inicial/foto queda debajo hasta que llega el primer fotograma.
    box.append(ctx.avatar(seat.username, seat.avatar));
    const video = videoEl(seat.userId);
    if (mine && localStream && video.srcObject !== localStream) {
      video.srcObject = localStream;
      video.classList.add('mirror');
    }
    const live = document.createElement('span');
    live.className = 'cam-live';
    live.textContent = mine ? 'Tú' : 'En vivo';
    box.append(video, live);
    return box;
  }

  /** Al rehacer las sillas los vídeos se sacan del documento y se pausan: se reanudan. */
  function resume() {
    for (const video of videos.values()) if (video.isConnected && video.paused && video.srcObject) video.play().catch(() => {});
  }

  function changed() {
    document.dispatchEvent(new CustomEvent('camera:change'));
  }

  function isOn() {
    return localStream !== null;
  }

  /** Al sentarse: pregunta si quiere activar la cámara. */
  function promptOnSit() {
    if (localStream) return;
    modal.show();
  }

  function init(appCtx) {
    ctx = appCtx;
    modal = window.bootstrap.Modal.getOrCreateInstance($('#camera-modal'));
    $('#camera-accept').addEventListener('click', () => {
      modal.hide();
      start();
    });
    ctx.socket.on('rtc:config', (config) => {
      if (Array.isArray(config?.iceServers)) iceServers = config.iceServers;
    });
    ctx.socket.on('rtc:signal', onSignal);
    ctx.socket.on('rtc:gone', ({ peer }) => {
      sending.get(peer)?.close();
      sending.delete(peer);
    });
    // Tras una reconexión el servidor ya no tiene mi cámara ni mis conexiones.
    ctx.socket.on('disconnect', () => {
      stop({ notify: false });
      resetViewing();
    });
  }

  return { init, start, stop, isOn, sync, mount, resume, resetViewing, promptOnSit };
})();
