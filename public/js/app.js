'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const CHIP_VALUES = [1, 5, 10, 25, 100];
  const TOAST_ICONS = { info: 'bi-info-circle-fill', error: 'bi-exclamation-triangle-fill', success: 'bi-check-circle-fill' };
  const CONFETTI_COLORS = ['#e8c46a', '#fff4cf', '#c1232c', '#16a35a', '#ffffff'];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let authMode = 'login';
  let socket = null;
  let credits = null;
  let shownCredits = null;
  let creditsTween = 0;
  let me = null;
  const AVATAR_SIZE = 256;

  const fireConfetti = window.confetti
    ? window.confetti.create($('#confetti-canvas'), { resize: true, useWorker: false, disableForReducedMotion: true })
    : null;

  function toast(message, kind = 'info') {
    const container = $('#toasts');
    // No repite el mismo aviso si ya está en pantalla.
    for (const el of container.children) if (el.dataset.message === message) return;
    while (container.children.length >= 3) container.firstElementChild.remove();

    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.dataset.message = message;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `
      <div class="d-flex align-items-center">
        <div class="toast-body d-flex align-items-center gap-2"><i class="bi ${TOAST_ICONS[kind]}"></i><span></span></div>
        <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>
      </div>`;
    el.querySelector('span').textContent = message;
    container.appendChild(el);
    el.addEventListener('hidden.bs.toast', () => el.remove());
    window.bootstrap.Toast.getOrCreateInstance(el, { delay: 3200 }).show();
  }

  const span = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const fmt = (n) => n.toLocaleString('es');

  // ---------- animación de victoria ----------

  const WIN_MS = 3300;
  const winQueue = [];
  let winShowing = false;

  /**
   * Anuncia una ganancia en el centro de la pantalla. Si ya hay una en curso,
   * espera su turno para que no se tapen (p. ej. ganar en ruleta y blackjack a la vez).
   * `amount` es lo que cobras; `net` (opcional) lo que ganas descontando lo apostado.
   */
  function celebrate({ amount, net = null, title = null, detail = '', big = false }) {
    // Si cobraste algo pero en total perdiste (p. ej. aciertas rojo y fallas un pleno), no es "ganaste".
    title ??= net !== null && net <= 0 ? '¡Acertaste!' : '¡Ganaste!';
    winQueue.push({ amount, net, title, detail, big });
    if (!winShowing) nextWin();
  }

  function countUp(el, value) {
    if (reducedMotion.matches) {
      el.textContent = `+${fmt(value)}`;
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1000);
      el.textContent = `+${fmt(Math.round(value * (1 - (1 - p) ** 3)))}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function nextWin() {
    const el = $('#celebrate');
    const win = winQueue.shift();
    if (!win) {
      winShowing = false;
      el.classList.remove('show');
      return;
    }
    winShowing = true;

    const card = document.createElement('div');
    card.className = 'win-card';
    const amount = span('c-amount', '+0');
    card.append(span('c-label', win.title), amount);
    const details = [win.detail];
    if (win.net !== null && win.net !== win.amount) details.push(`Neto ${win.net >= 0 ? '+' : '−'}${fmt(Math.abs(win.net))}`);
    const detailText = details.filter(Boolean).join(' · ');
    if (detailText) card.append(span('c-detail', detailText));
    const rays = document.createElement('div');
    rays.className = 'win-rays';
    el.replaceChildren(rays, card);
    el.classList.toggle('big', win.big);
    el.classList.remove('show');
    void el.offsetWidth; // reinicia la animación
    el.classList.add('show');
    countUp(amount, win.amount);

    if (fireConfetti && !reducedMotion.matches && (win.net ?? win.amount) > 0) {
      const count = win.big ? 170 : 90;
      fireConfetti({ particleCount: count, spread: 70, angle: 60, origin: { x: 0.1, y: 0.75 }, colors: CONFETTI_COLORS });
      fireConfetti({ particleCount: count, spread: 70, angle: 120, origin: { x: 0.9, y: 0.75 }, colors: CONFETTI_COLORS });
      if (win.big) {
        setTimeout(() => fireConfetti({ particleCount: 120, spread: 120, startVelocity: 45, origin: { y: 0.45 }, colors: CONFETTI_COLORS }), 250);
      }
    }
    setTimeout(nextWin, WIN_MS);
  }

  // ---------- fotos de perfil ----------

  const hueOf = (name) => {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };

  /** Foto de perfil, o la inicial sobre un color propio de cada jugador. */
  function avatarEl(name, url, extra = '') {
    const cls = extra ? `avatar ${extra}` : 'avatar';
    if (url) {
      const img = document.createElement('img');
      img.className = cls;
      img.src = url;
      img.alt = '';
      img.decoding = 'async';
      return img;
    }
    const el = span(cls, name.slice(0, 1));
    el.style.setProperty('--hue', hueOf(name));
    return el;
  }

  function setMyAvatar(url) {
    me.avatar = url;
    for (const [id, extra] of [['avatar', ''], ['profile-avatar', 'avatar-xl']]) {
      const el = avatarEl(me.username, url, extra);
      el.id = id;
      el.setAttribute('aria-hidden', 'true');
      $(`#${id}`).replaceWith(el);
    }
    $('#avatar-remove').disabled = !url;
  }

  /** Recorta la imagen en cuadrado y la reduce a 256×256 antes de subirla. */
  async function prepareAvatar(file) {
    if (!file.type.startsWith('image/')) throw new Error('Elige un archivo de imagen.');
    if (file.size > 20 * 1024 * 1024) throw new Error('La imagen pesa demasiado (máx. 20 MB).');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('No se pudo leer la imagen. Prueba con una JPG o PNG.');
    }
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const g = canvas.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    bitmap.close();
    const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // Safari no codifica WebP y devuelve PNG: en ese caso se usa JPEG.
    const webp = await toBlob('image/webp', 0.86);
    return webp?.type === 'image/webp' ? webp : toBlob('image/jpeg', 0.88);
  }

  async function uploadAvatar(file) {
    showError($('#profile-error'), '');
    $('#avatar-busy').classList.remove('hidden');
    try {
      const data = await api('/api/avatar', await prepareAvatar(file), 'PUT');
      setMyAvatar(data.avatar);
      toast('Foto de perfil actualizada', 'success');
    } catch (err) {
      showError($('#profile-error'), err.message);
    } finally {
      $('#avatar-busy').classList.add('hidden');
      $('#avatar-input').value = '';
    }
  }

  $('#avatar-input').addEventListener('change', (e) => {
    const [file] = e.target.files;
    if (file) uploadAvatar(file);
  });

  $('#avatar-remove').addEventListener('click', async () => {
    showError($('#profile-error'), '');
    try {
      await api('/api/avatar', null, 'DELETE');
      setMyAvatar(null);
    } catch (err) {
      showError($('#profile-error'), err.message);
    }
  });

  const drop = $('#profile-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const [file] = e.dataTransfer.files;
    if (file) uploadAvatar(file);
  });

  $('#profile-modal').addEventListener('hidden.bs.modal', () => showError($('#profile-error'), ''));

  async function api(path, body = null, method = body ? 'POST' : 'GET') {
    const isFile = body instanceof Blob;
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': isFile ? body.type : 'application/json' } : {},
      body: body ? (isFile ? body : JSON.stringify(body)) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error de conexión');
    return data;
  }

  /** Emite un evento y espera la confirmación del servidor ({ ok, error }). */
  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(5000).emit(event, payload, (err, res) => {
        resolve(err ? { ok: false, error: 'El servidor no respondió' } : res);
      });
    });
  }

  function renderChips(container, onPick, selectable = false) {
    container.innerHTML = '';
    CHIP_VALUES.forEach((value, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip chip-${value}`;
      chip.textContent = value;
      chip.dataset.value = value;
      chip.setAttribute('aria-label', `Ficha de ${value}`);
      if (selectable && i === 0) chip.classList.add('selected');
      chip.addEventListener('click', () => {
        if (selectable) {
          container.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
        }
        onPick(value, chip);
      });
      container.appendChild(chip);
    });
  }

  function restartAnimation(el, ...classes) {
    el.classList.remove('flash-up', 'flash-down', 'up', 'down');
    void el.offsetWidth;
    el.classList.add(...classes);
  }

  function setCredits(value) {
    const label = $('#credits');
    if (credits !== null && value !== credits) {
      const up = value > credits;
      restartAnimation($('.credits'), up ? 'flash-up' : 'flash-down');
      const delta = $('#credits-delta');
      delta.textContent = `${up ? '+' : '−'}${Math.abs(value - credits).toLocaleString('es')}`;
      restartAnimation(delta, up ? 'up' : 'down');
    }
    credits = value;

    // El número cuenta hasta el nuevo saldo en lugar de saltar.
    cancelAnimationFrame(creditsTween);
    const from = shownCredits ?? value;
    if (from === value || reducedMotion.matches) {
      shownCredits = value;
      label.textContent = value.toLocaleString('es');
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 700);
      shownCredits = Math.round(from + (value - from) * (1 - (1 - p) ** 3));
      label.textContent = shownCredits.toLocaleString('es');
      if (p < 1) creditsTween = requestAnimationFrame(step);
    };
    creditsTween = requestAnimationFrame(step);
  }

  // ---------- acceso ----------

  function showAuth() {
    $('#app-view').classList.add('hidden');
    $('#auth-view').classList.remove('hidden');
    $('#auth-username').focus();
  }

  function showError(el, message) {
    el.textContent = message;
    el.classList.remove('shake');
    void el.offsetWidth;
    if (message) el.classList.add('shake');
  }

  document.querySelectorAll('.auth-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.mode;
      document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $('#auth-submit-label').textContent = authMode === 'login' ? 'Entrar' : 'Crear cuenta y recibir 100 créditos';
      $('#auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      showError($('#auth-error'), '');
    });
  });

  $('#toggle-password').addEventListener('click', (e) => {
    const input = $('#auth-password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
    e.currentTarget.querySelector('i').className = `bi ${visible ? 'bi-eye' : 'bi-eye-slash'}`;
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const submit = $('#auth-submit');
    submit.disabled = true;
    $('#auth-spinner').classList.remove('hidden');
    showError($('#auth-error'), '');
    try {
      const data = await api(`/api/${authMode}`, {
        username: form.username.value.trim(),
        password: form.password.value,
      });
      form.reset();
      startApp(data.user);
      if (data.bonusGranted) {
        toast('¡Bienvenido! Recibiste 100 créditos de regalo.', 'success');
        celebrate({ amount: 100, title: 'Bono de bienvenida', detail: 'Tus primeros créditos', big: true });
      }
    } catch (err) {
      showError($('#auth-error'), err.message);
    } finally {
      submit.disabled = false;
      $('#auth-spinner').classList.add('hidden');
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', {}).catch(() => {});
    location.reload();
  });

  // ---------- pestañas ----------

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.game').forEach((g) => {
        const show = g.id === btn.dataset.tab;
        g.classList.toggle('hidden', !show);
        g.classList.remove('game-enter');
        if (show) {
          void g.offsetWidth;
          g.classList.add('game-enter');
        }
      });
      if (btn.dataset.tab === 'roulette') {
        window.RouletteUI.resize();
        window.ChatUI.setChannel('roulette', 'Ruleta');
      } else {
        const { channel, label } = window.BlackjackUI.chatChannel();
        window.ChatUI.setChannel(channel, label);
      }
    });
  });

  document.querySelectorAll('[data-copy-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(me.publicId);
        toast(`ID ${me.publicId} copiado`, 'success');
      } catch {
        toast(`Tu ID es ${me.publicId}`);
      }
    });
  });

  // ---------- arranque ----------

  function startApp(user) {
    $('#auth-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    me = user;
    $('#username').textContent = user.username;
    $('#profile-name').textContent = user.username;
    document.querySelectorAll('.my-public-id').forEach((el) => { el.textContent = user.publicId; });
    document.querySelector('.user-chip').title = `Tu perfil · ID ${user.publicId}`;
    setMyAvatar(user.avatar);
    setCredits(user.credits);

    socket = io();
    socket.on('balance', ({ credits: value }) => setCredits(value));
    socket.on('profile', ({ avatar }) => setMyAvatar(avatar));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') location.reload();
    });
    socket.on('disconnect', () => toast('Conexión perdida, reconectando…', 'error'));

    const ctx = {
      socket, emit, api, toast, celebrate, renderChips, avatar: avatarEl, reducedMotion, user,
      credits: () => credits,
      chat: window.ChatUI,
      transfer: window.TransferUI,
    };
    window.ChatUI.init(ctx);
    window.TransferUI.init(ctx);
    window.RouletteUI.init(ctx);
    window.BlackjackUI.init(ctx);
  }

  api('/api/me').then((data) => startApp(data.user)).catch(showAuth);
})();
