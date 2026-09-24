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

  /** Muestra una ganancia grande en pantalla con confeti. */
  function celebrate(amount, label = '¡Ganas!', big = false) {
    const el = $('#celebrate');
    const box = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'c-label';
    title.textContent = label;
    const value = document.createElement('span');
    value.className = 'c-amount';
    value.textContent = `+${amount.toLocaleString('es')}`;
    box.append(title, value);
    el.replaceChildren(box);
    el.classList.remove('show');
    void el.offsetWidth; // reinicia la animación
    el.classList.add('show');

    if (!fireConfetti || reducedMotion.matches) return;
    const count = big ? 170 : 90;
    fireConfetti({ particleCount: count, spread: 70, angle: 60, origin: { x: 0.1, y: 0.75 }, colors: CONFETTI_COLORS });
    fireConfetti({ particleCount: count, spread: 70, angle: 120, origin: { x: 0.9, y: 0.75 }, colors: CONFETTI_COLORS });
    if (big) {
      setTimeout(() => fireConfetti({ particleCount: 120, spread: 120, startVelocity: 45, origin: { y: 0.45 }, colors: CONFETTI_COLORS }), 250);
    }
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
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

  function showError(message) {
    const el = $('#auth-error');
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
      showError('');
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
    showError('');
    try {
      const data = await api(`/api/${authMode}`, {
        username: form.username.value.trim(),
        password: form.password.value,
      });
      form.reset();
      startApp(data.user);
      if (data.bonusGranted) {
        toast('¡Bienvenido! Recibiste 100 créditos de regalo.', 'success');
        celebrate(100, 'Bono de bienvenida', true);
      }
    } catch (err) {
      showError(err.message);
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
      if (btn.dataset.tab === 'roulette') window.RouletteUI.resize();
    });
  });

  // ---------- arranque ----------

  function startApp(user) {
    $('#auth-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#username').textContent = user.username;
    $('#avatar').textContent = user.username.slice(0, 1);
    setCredits(user.credits);

    socket = io();
    socket.on('balance', ({ credits: value }) => setCredits(value));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') location.reload();
    });
    socket.on('disconnect', () => toast('Conexión perdida, reconectando…', 'error'));

    const ctx = { socket, emit, toast, celebrate, renderChips, reducedMotion, user };
    window.RouletteUI.init(ctx);
    window.BlackjackUI.init(ctx);
  }

  api('/api/me').then((data) => startApp(data.user)).catch(showAuth);
})();
