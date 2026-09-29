'use strict';

// Botón "+100" y modal del anuncio con recompensa. Ni el archivo ni los id/clases usan "ad"/"ads":
// los bloqueadores de anuncios (EasyList: ###ad-wrap, ##.ad-btn…) los ocultarían.
// El contador de aquí es solo para el
// jugador (se pausa si cambia de pestaña): el servidor comprueba el tiempo por su cuenta
// al reclamar. El token del anuncio se guarda solo en memoria; al recargar, /start devuelve
// el mismo anuncio pendiente.
window.RewardsUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => n.toLocaleString('es');
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const STATUS_MAX_AGE_MS = 30_000; // al volver a la pestaña, se revisa el botón si es más viejo

  let ctx;
  let modal;
  let tooltip;
  let tip = '';

  // Botón
  let status = null; // último /api/ads/status (null = sin anuncios)
  let statusAt = 0;
  let statusBusy = false;
  let statusAgain = false;
  let cooldownEnd = 0;
  let cooldownTimer = 0;
  let starting = false;

  // Modal
  let current = null; // { token, duration, reward, ad } del anuncio abierto
  let elapsed = 0; // ms vistos con la pestaña visible
  let tickAt = 0;
  let ticker = 0;
  let claiming = false;
  let spoken = '';

  // ---------- botón ----------

  function setTip(text) {
    tip = text;
    $('#rw-open').setAttribute('aria-label', text);
    if (tooltip) tooltip.setContent({ '.tooltip-inner': text });
  }

  function renderButton() {
    clearInterval(cooldownTimer);
    const wrap = $('#rw-wrap');
    const btn = $('#rw-open');
    wrap.classList.toggle('hidden', !status?.enabled);
    if (!status?.enabled) return tooltip?.hide();

    const reward = `+${fmt(status.reward)}`;
    btn.disabled = !status.available || starting;
    // Un botón desactivado no recibe el foco: lo recibe el envoltorio, para ver el aviso.
    if (btn.disabled) wrap.tabIndex = 0;
    else wrap.removeAttribute('tabindex');

    if (status.available) {
      $('#rw-label').textContent = reward;
      setTip(`Mira un anuncio y gana ${fmt(status.reward)} créditos`);
    } else if (status.remainingToday === 0) {
      $('#rw-label').textContent = reward;
      setTip('Vuelve mañana');
    } else {
      cooldownEnd = performance.now() + status.cooldownSeconds * 1000;
      setTip('Pronto podrás ver otro anuncio');
      tickCooldown();
      cooldownTimer = setInterval(tickCooldown, 1000);
    }
  }

  function tickCooldown() {
    const left = Math.ceil((cooldownEnd - performance.now()) / 1000);
    if (left <= 0) {
      clearInterval(cooldownTimer);
      refreshStatus();
      return;
    }
    $('#rw-label').textContent = mmss(left);
  }

  /** Pide el estado del botón. Si ya hay una petición en curso, repite al terminar. */
  async function refreshStatus() {
    if (statusBusy) {
      statusAgain = true;
      return;
    }
    statusBusy = true;
    try {
      status = await ctx.api('/api/ads/status');
    } catch (err) {
      // 404: anuncios desactivados. Otro error: se deja el botón como estaba.
      if (err.status === 404) status = null;
    } finally {
      statusAt = Date.now();
      statusBusy = false;
      renderButton();
    }
    if (statusAgain) {
      statusAgain = false;
      refreshStatus();
    }
  }

  async function start() {
    if (starting) return;
    starting = true;
    $('#rw-open').disabled = true;
    tooltip.hide();
    try {
      show(await ctx.api('/api/ads/start', {}));
    } catch (err) {
      ctx.toast(err.message, 'error');
      refreshStatus();
    } finally {
      starting = false;
      if (!current) renderButton();
    }
  }

  // ---------- modal ----------

  const setError = (message) => { $('#rw-error').textContent = message; };

  /** Texto para lectores de pantalla (aria-live): solo se cambia cuando dice algo nuevo. */
  function say(text) {
    if (text === spoken) return;
    spoken = text;
    $('#rw-status').textContent = text;
  }

  const hint = (text) => { $('#rw-hint').textContent = text; };

  function video() {
    return $('#rw-media video');
  }

  function renderMedia(ad) {
    const box = $('#rw-media');
    box.classList.toggle('is-image', ad.type !== 'video');
    $('#rw-sound').classList.toggle('hidden', ad.type !== 'video');
    let el;
    if (ad.type === 'video') {
      el = document.createElement('video');
      // Silenciado al empezar para que los móviles lo reproduzcan solos.
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.loop = true;
      el.disablePictureInPicture = true;
      el.setAttribute('muted', '');
      el.setAttribute('playsinline', '');
      el.setAttribute('aria-label', ad.title);
      el.src = ad.src;
      setSound(false, el);
    } else {
      el = document.createElement('img');
      el.src = ad.src;
      el.alt = ad.title;
      el.decoding = 'async';
    }
    // Con enlace, pulsar la imagen o el vídeo abre el sitio del anunciante en otra pestaña
    // (como "Ver más"). El contador del servidor sigue corriendo.
    if (ad.link) {
      const a = document.createElement('a');
      a.className = 'rw-media-link';
      a.href = ad.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', `${ad.title} (se abre en otra pestaña)`);
      a.append(el);
      el = a;
    }
    box.replaceChildren(el);
    $('#rw-title-text').textContent = ad.title;
    const link = $('#rw-link');
    link.classList.toggle('hidden', !ad.link);
    if (ad.link) link.href = ad.link;
    else link.removeAttribute('href');
  }

  function setSound(on, el = video()) {
    if (!el) return;
    el.muted = !on;
    const btn = $('#rw-sound');
    btn.querySelector('i').className = `bi ${on ? 'bi-volume-up-fill' : 'bi-volume-mute-fill'}`;
    btn.setAttribute('aria-label', on ? 'Silenciar anuncio' : 'Activar sonido');
    btn.setAttribute('aria-pressed', String(on));
  }

  function show(data) {
    current = data;
    elapsed = 0;
    spoken = '';
    setError('');
    renderMedia(data.ad);
    $('#rw-claim-label').textContent = `Reclamar ${fmt(data.reward)} créditos`;
    $('#rw-claim').disabled = true;
    modal.show();
    tickAt = performance.now();
    clearInterval(ticker);
    ticker = setInterval(tick, 250);
    tick();
  }

  function tick() {
    if (!current) return;
    const now = performance.now();
    const visible = document.visibilityState === 'visible';
    if (visible) elapsed += now - tickAt;
    tickAt = now;

    const total = current.duration * 1000;
    const left = Math.max(0, Math.ceil((total - elapsed) / 1000));
    $('#rw-progress').style.width = `${total ? Math.min(100, (elapsed / total) * 100) : 100}%`;
    $('#rw-timer').textContent = left ? `${left} s` : '';
    if (left === 0) {
      clearInterval(ticker);
      if (!claiming) $('#rw-claim').disabled = false;
      hint('¡Listo!');
      say(`¡Listo! Ya puedes reclamar tus ${fmt(current.reward)} créditos.`);
      return;
    }
    hint(visible ? 'Tu recompensa en' : 'En pausa');
    // Al lector de pantalla, cada 10 s (cada segundo sería demasiado).
    if (!visible) say('Anuncio en pausa.');
    else if (spoken === '' || spoken === 'Anuncio en pausa.' || left % 10 === 0) say(`Faltan ${left} segundos.`);
  }

  /** El contador y el vídeo se paran mientras la pestaña no se ve. */
  function onVisibility() {
    const now = performance.now();
    const visible = document.visibilityState === 'visible';
    if (current && !visible) elapsed += now - tickAt; // lo visto hasta ahora cuenta
    tickAt = now;
    const el = video();
    if (el) {
      if (visible) el.play().catch(() => {});
      else el.pause();
    }
    if (current) tick();
    if (visible && !current && Date.now() - statusAt > STATUS_MAX_AGE_MS) refreshStatus();
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Reclama; si el servidor dice que aún faltan segundos (reloj desfasado), espera y reintenta una vez. */
  async function claimToken(token) {
    try {
      return await ctx.api('/api/ads/claim', { token });
    } catch (err) {
      const seconds = err.status === 425 ? Number(err.data?.retryAfter) : 0;
      if (!(seconds > 0 && seconds <= 60)) throw err;
      hint('Un momento…');
      say(`Un momento… (${seconds} s)`);
      await wait(seconds * 1000 + 300);
      return ctx.api('/api/ads/claim', { token });
    }
  }

  async function claim() {
    if (!current || claiming) return;
    claiming = true;
    $('#rw-claim').disabled = true;
    setError('');
    try {
      const { reward } = await claimToken(current.token);
      current = null;
      modal.hide();
      ctx.toast(`+${fmt(reward)} créditos`, 'success');
      ctx.confetti();
      // El saldo llega por el socket ('balance'), en todas las pestañas.
    } catch (err) {
      setError(err.message);
      // Caducado, ya cobrado o inexistente: este anuncio ya no se puede reclamar.
      if ([404, 409, 410].includes(err.status)) current = null;
      else $('#rw-claim').disabled = false;
    } finally {
      claiming = false; // el botón se actualiza al cerrarse el modal
    }
  }

  function onHidden() {
    clearInterval(ticker);
    const el = video();
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load(); // corta la descarga del vídeo
    }
    $('#rw-media').replaceChildren();
    // Si se canceló, el anuncio sigue pendiente en el servidor: el botón lo retoma con el mismo token.
    current = null;
    refreshStatus();
  }

  /** Se cobró un anuncio (en esta u otra pestaña). */
  function onClaimed() {
    if (current && !claiming && $('#rw-modal').classList.contains('show')) {
      current = null;
      modal.hide(); // otra pestaña cobró este mismo anuncio
    }
    refreshStatus();
  }

  function init(appCtx) {
    ctx = appCtx;
    modal = window.bootstrap.Modal.getOrCreateInstance($('#rw-modal'));
    tooltip = new window.bootstrap.Tooltip($('#rw-wrap'), { title: () => tip, placement: 'bottom', trigger: 'hover focus' });
    $('#rw-open').addEventListener('click', start);
    $('#rw-claim').addEventListener('click', claim);
    $('#rw-sound').addEventListener('click', () => {
      const el = video();
      if (!el) return;
      setSound(el.muted);
      el.play().catch(() => {});
    });
    $('#rw-modal').addEventListener('hidden.bs.modal', onHidden);
    document.addEventListener('visibilitychange', onVisibility);
    ctx.socket.on('ads:claimed', onClaimed);
    refreshStatus();
  }

  return { init };
})();
