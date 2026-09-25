'use strict';

// Cámaras y chat de voz en la mesa de blackjack, con WebRTC entre navegadores.
// El servidor solo reenvía la señalización (rtc:signal); vídeo y audio van de
// navegador a navegador. Quien está sentado y activa cámara y/o micrófono los emite;
// cada espectador de la mesa le pide el stream ("want") y el emisor responde con una
// oferta. Al encender o apagar algo, el servidor sube `rev` y los espectadores se
// reconectan con los nuevos tracks.
window.MediaUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const MAX_VIEWERS = 20; // cada espectador es una subida más para el emisor
  const MAX_VIDEO_BITRATE = 250_000;
  const RETRY_MS = 4_000;
  const MAX_RETRIES = 3;
  const SPEAKING_LEVEL = 0.04; // volumen (RMS) a partir del cual se marca que habla
  const VIDEO = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' };
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  let ctx;
  let modal;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null; // mis tracks (vídeo y/o audio)
  let busy = false;
  let deafened = false; // el jugador silenció la mesa
  let audioBlocked = false; // el navegador no dejó reproducir sonido sin un clic
  const sending = new Map(); // socket del espectador -> RTCPeerConnection
  const receiving = new Map(); // "socket#rev" del emisor -> { pc, userId, pending, retries, timer }
  const videos = new Map(); // userId -> <video> (persistente entre renders de la mesa)
  const audios = new Map(); // userId -> <audio> (fuera de la mesa, nunca se mueve)
  const meters = new Map(); // userId -> AnalyserNode (indicador de quién habla)
  let audioCtx = null;

  const send = (to, kind, extra = {}) => ctx.socket.emit('rtc:signal', { to, kind, ...extra });
  const hasVideo = () => !!localStream?.getVideoTracks().length;
  const hasAudio = () => !!localStream?.getAudioTracks().length;

  function changed() {
    document.dispatchEvent(new CustomEvent('media:change'));
  }

  // ---------- elementos de vídeo y audio ----------

  function videoEl(userId) {
    let video = videos.get(userId);
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.muted = true; // el sonido va por su <audio>; así el navegador deja reproducir solo
      video.playsInline = true;
      // WebRTC entrega primero un fotograma vacío de 2×2: se muestra el vídeo solo cuando
      // llegan fotogramas reales (mientras, se ve la foto del jugador debajo).
      const markLive = () => video.classList.toggle('live', video.videoWidth > 16);
      for (const event of ['loadeddata', 'resize', 'playing']) video.addEventListener(event, markLive);
      videos.set(userId, video);
    }
    return video;
  }

  function playAudio(audio) {
    audio.play().then(
      () => {
        if (audioBlocked) {
          audioBlocked = false;
          changed();
        }
      },
      (err) => {
        // Sin un clic previo, algunos navegadores (sobre todo Safari) no reproducen sonido.
        if (err?.name === 'NotAllowedError' && !audioBlocked) {
          audioBlocked = true;
          changed();
        }
      }
    );
  }

  function attachAudio(userId, stream) {
    let audio = audios.get(userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      $('#bj-audio').append(audio);
      audios.set(userId, audio);
    }
    audio.muted = deafened;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    playAudio(audio);
    watchLevel(userId, stream);
  }

  function dropMedia(userId) {
    const video = videos.get(userId);
    if (video) {
      video.srcObject = null;
      video.remove();
      videos.delete(userId);
    }
    const audio = audios.get(userId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      audios.delete(userId);
    }
    meters.get(userId)?.disconnect();
    meters.delete(userId);
  }

  // ---------- quién está hablando ----------

  function watchLevel(userId, stream) {
    if (!stream.getAudioTracks().length || meters.has(userId)) return;
    try {
      audioCtx ??= new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      meters.set(userId, analyser);
    } catch {
      // sin Web Audio no hay indicador, pero el audio se sigue oyendo
    }
  }

  const levelBuffer = new Float32Array(512);
  function speakingTick() {
    if (!meters.size) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    for (const [userId, analyser] of meters) {
      analyser.getFloatTimeDomainData(levelBuffer);
      let sum = 0;
      for (const v of levelBuffer) sum += v * v;
      const speaking = Math.sqrt(sum / levelBuffer.length) > SPEAKING_LEVEL;
      document.querySelector(`#bj-seats .seat[data-user="${userId}"]`)?.classList.toggle('speaking', speaking);
    }
  }

  // ---------- emitir mi cámara / micrófono ----------

  function errorMessage(err, kind) {
    const device = kind === 'audio' ? 'el micrófono' : kind === 'video' ? 'la cámara' : 'la cámara y el micrófono';
    if (!window.isSecureContext) return `${device[0].toUpperCase()}${device.slice(1)} solo funciona en una conexión segura (HTTPS).`;
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError': return `No diste permiso para usar ${device}. Puedes activarlo en el candado de la barra de direcciones.`;
      // P. ej. navegadores dentro de otras apps (Instagram, TikTok…), que no dan acceso.
      case 'NotSupportedError': return `Este navegador no permite usar ${device} aquí. Prueba con Chrome, Safari o Firefox.`;
      case 'NotFoundError': return `No se encontró ${kind === 'audio' ? 'ningún micrófono' : 'ninguna cámara'}.`;
      case 'NotReadableError': return `${device[0].toUpperCase()}${device.slice(1)} está siendo usado por otra aplicación.`;
      default: return `No se pudo activar ${device}.`;
    }
  }

  function closeSending() {
    for (const pc of sending.values()) pc.close();
    sending.clear();
  }

  /** Enciende o apaga cámara y micrófono (undefined = no tocar). Pide los permisos que falten de una vez. */
  async function set({ video = hasVideo(), audio = hasAudio() } = {}) {
    if (busy) return;
    if ((video || audio) && !navigator.mediaDevices?.getUserMedia) return ctx.toast(errorMessage(null), 'error');
    busy = true;
    try {
      const need = { video: video && !hasVideo() ? VIDEO : false, audio: audio && !hasAudio() ? AUDIO : false };
      let fresh = null;
      if (need.video || need.audio) {
        try {
          fresh = await navigator.mediaDevices.getUserMedia(need);
        } catch (err) {
          return ctx.toast(errorMessage(err, need.video && need.audio ? null : need.video ? 'video' : 'audio'), 'error');
        }
      }
      // Los espectadores se reconectan con los nuevos tracks (el servidor sube `rev`).
      closeSending();
      const tracks = [
        ...(localStream?.getTracks() ?? []).filter((t) => (t.kind === 'video' ? video : audio)),
        ...(fresh?.getTracks() ?? []),
      ];
      for (const t of localStream?.getTracks() ?? []) if (!tracks.includes(t)) t.stop();
      localStream = tracks.length ? new MediaStream(tracks) : null;
      for (const t of fresh?.getTracks() ?? []) t.addEventListener('ended', () => set({ [t.kind]: false }));

      if (localStream && hasAudio()) watchLevel(ctx.user.id, localStream);
      else {
        meters.get(ctx.user.id)?.disconnect();
        meters.delete(ctx.user.id);
      }
      if (!hasVideo()) {
        const mine = videos.get(ctx.user.id);
        if (mine) mine.srcObject = null;
      }

      const res = await ctx.emit('bj:media', { video: hasVideo(), audio: hasAudio() });
      if (!res.ok) {
        stopLocal();
        return ctx.toast(res.error, 'error');
      }
      if (need.video) ctx.toast('Cámara activada: te ven en tu asiento', 'success');
      if (need.audio) ctx.toast('Micrófono activado: te oyen en la mesa', 'success');
    } finally {
      busy = false;
      changed();
    }
  }

  function stopLocal() {
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    closeSending();
    const mine = videos.get(ctx.user.id);
    if (mine) mine.srcObject = null;
    meters.get(ctx.user.id)?.disconnect();
    meters.delete(ctx.user.id);
  }

  /** Apaga cámara y micrófono. `notify: false` cuando ya no estoy sentado (el servidor ya lo sabe). */
  function stop({ notify = true } = {}) {
    if (!localStream) return;
    stopLocal();
    if (notify) ctx.emit('bj:media', { video: false, audio: false });
    changed();
  }

  async function onWant(viewer) {
    if (!localStream || sending.size >= MAX_VIEWERS) return send(viewer, 'bye');
    sending.get(viewer)?.close();
    const pc = new RTCPeerConnection({ iceServers });
    sending.set(viewer, pc);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => e.candidate && send(viewer, 'candidate', { candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && sending.get(viewer) === pc) {
        pc.close();
        sending.delete(viewer);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    // Vídeo en calidad baja a propósito: con la mesa llena hay muchas cámaras a la vez.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: MAX_VIDEO_BITRATE }];
      await sender.setParameters(params).catch(() => {});
    }
    send(viewer, 'offer', { sdp: pc.localDescription.sdp });
  }

  // ---------- ver y oír a los demás ----------

  const keyOf = (peer, rev) => `${peer}#${rev}`;
  const peerOf = (key) => key.slice(0, key.lastIndexOf('#'));

  function closeReceiving(key) {
    const entry = receiving.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.pc?.close();
    receiving.delete(key);
    // Si el mismo jugador sigue emitiendo con otra versión, sus elementos se reutilizan.
    if (![...receiving.values()].some((e) => e.userId === entry.userId)) dropMedia(entry.userId);
  }

  function request(key, userId, retries = 0) {
    const peer = peerOf(key);
    const pc = new RTCPeerConnection({ iceServers });
    const entry = { pc, userId, pending: [], retries, timer: null };
    receiving.set(key, entry);
    pc.onicecandidate = (e) => e.candidate && send(peer, 'candidate', { candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (e.track.kind === 'video') {
        const video = videoEl(userId);
        video.srcObject = stream;
        video.play().catch(() => {});
      } else {
        attachAudio(userId, stream);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' || receiving.get(key) !== entry) return;
      // Reintenta unas veces por si fue un corte momentáneo de red.
      pc.close();
      if (entry.retries >= MAX_RETRIES) return;
      entry.timer = setTimeout(() => {
        if (receiving.get(key) === entry) request(key, userId, entry.retries + 1);
      }, RETRY_MS);
    };
    send(peer, 'want');
  }

  /** El emisor habla con el socket, sin versión: la conexión viva es la última pedida. */
  function receivingFrom(peer) {
    let found = null;
    for (const [key, entry] of receiving) if (peerOf(key) === peer) found = entry;
    return found;
  }

  async function onSignal({ from, kind, sdp, candidate }) {
    try {
      if (kind === 'want') return await onWant(from);
      if (kind === 'bye') {
        for (const key of [...receiving.keys()]) if (peerOf(key) === from) closeReceiving(key);
        return;
      }
      if (kind === 'answer') return await sending.get(from)?.setRemoteDescription({ type: 'answer', sdp });

      const entry = receivingFrom(from);
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
      console.warn('[media]', kind, err);
    }
  }

  /**
   * Se llama en cada render de la mesa: pide el stream de quien empezó a emitir (o
   * cambió cámara/micrófono) y cierra lo que ya no está.
   */
  function sync(state) {
    const wanted = new Map();
    for (const seat of state?.seats ?? []) {
      const m = seat?.media;
      if (m && m.peer !== ctx.socket.id) wanted.set(keyOf(m.peer, m.rev), seat.userId);
    }
    for (const key of [...receiving.keys()]) if (!wanted.has(key)) closeReceiving(key);
    for (const [key, userId] of wanted) if (!receiving.has(key)) request(key, userId);
  }

  /** Al cambiar de mesa: deja de ver y oír la anterior (lo mío sigue emitiendo). */
  function resetViewing() {
    for (const key of [...receiving.keys()]) closeReceiving(key);
  }

  /** Recuadro de vídeo para una silla, o null si esa silla no tiene cámara. */
  function mount(seat, mine) {
    if (!seat.media?.video) return null;
    const box = document.createElement('div');
    box.className = 'seat-cam';
    // La inicial/foto queda debajo hasta que llega el primer fotograma.
    box.append(ctx.avatar(seat.username, seat.avatar));
    const video = videoEl(seat.userId);
    if (mine && localStream && hasVideo() && video.srcObject !== localStream) {
      video.srcObject = localStream;
      video.classList.add('mirror');
    }
    const live = document.createElement('span');
    live.className = 'cam-live';
    live.textContent = mine ? 'Tú' : 'En vivo';
    box.append(video, live);
    return box;
  }

  /** Al rehacer una silla su vídeo sale del documento y se pausa: se reanuda. */
  function resume() {
    for (const video of videos.values()) if (video.isConnected && video.paused && video.srcObject) video.play().catch(() => {});
  }

  /** Silenciar o volver a oír la mesa (también sirve de clic para desbloquear el sonido). */
  function setDeafened(value) {
    deafened = value;
    audioCtx?.resume().catch(() => {});
    for (const audio of audios.values()) {
      audio.muted = deafened;
      if (!deafened) playAudio(audio);
    }
    changed();
  }

  /** Al sentarse: pregunta si quiere activar la cámara (y, si quiere, el micrófono). */
  function promptOnSit() {
    if (localStream) return;
    audioCtx?.resume().catch(() => {});
    modal.show();
  }

  function init(appCtx) {
    ctx = appCtx;
    modal = window.bootstrap.Modal.getOrCreateInstance($('#camera-modal'));
    $('#camera-accept').addEventListener('click', () => {
      modal.hide();
      set({ video: true, audio: $('#camera-with-mic').checked });
    });
    ctx.socket.on('rtc:config', (config) => {
      if (Array.isArray(config?.iceServers)) iceServers = config.iceServers;
    });
    ctx.socket.on('rtc:signal', onSignal);
    ctx.socket.on('rtc:gone', ({ peer }) => {
      sending.get(peer)?.close();
      sending.delete(peer);
    });
    // Tras una reconexión el servidor ya no tiene mis tracks ni mis conexiones.
    ctx.socket.on('disconnect', () => {
      stop({ notify: false });
      resetViewing();
    });
    setInterval(speakingTick, 150);
  }

  return {
    init,
    set,
    stop,
    sync,
    mount,
    resume,
    resetViewing,
    promptOnSit,
    setDeafened,
    isVideoOn: hasVideo,
    isAudioOn: hasAudio,
    isOn: () => localStream !== null,
    isDeafened: () => deafened,
    isAudioBlocked: () => audioBlocked,
    hasRemoteAudio: () => audios.size > 0,
  };
})();
