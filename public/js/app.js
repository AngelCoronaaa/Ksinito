'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const CHIP_VALUES = [1, 5, 10, 25, 100];

  let authMode = 'login';
  let socket = null;
  let credits = null;

  function toast(message, kind = 'info') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.className = 'toast'; }, 3200);
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
      chip.setAttribute('aria-label', `Ficha de ${value}`);
      if (selectable && i === 0) chip.classList.add('selected');
      chip.addEventListener('click', () => {
        if (selectable) {
          container.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
        }
        onPick(value);
      });
      container.appendChild(chip);
    });
  }

  function setCredits(value) {
    const el = $('.credits');
    if (credits !== null && value !== credits) {
      el.classList.remove('flash-up', 'flash-down');
      void el.offsetWidth; // reinicia la animación
      el.classList.add(value > credits ? 'flash-up' : 'flash-down');
    }
    credits = value;
    $('#credits').textContent = value.toLocaleString('es');
  }

  // ---------- acceso ----------

  function showAuth() {
    $('#app-view').classList.add('hidden');
    $('#auth-view').classList.remove('hidden');
  }

  document.querySelectorAll('.auth-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.mode;
      document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $('#auth-submit').textContent = authMode === 'login' ? 'Entrar' : 'Crear cuenta y recibir 100 créditos';
      $('#auth-form [name=password]').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      $('#auth-error').textContent = '';
    });
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const submit = $('#auth-submit');
    submit.disabled = true;
    $('#auth-error').textContent = '';
    try {
      const data = await api(`/api/${authMode}`, {
        username: form.username.value.trim(),
        password: form.password.value,
      });
      form.reset();
      startApp(data.user);
      if (data.bonusGranted) toast('¡Bienvenido! Recibiste 100 créditos de regalo.', 'success');
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', {}).catch(() => {});
    location.reload();
  });

  // ---------- pestañas ----------

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.game').forEach((g) => g.classList.toggle('hidden', g.id !== btn.dataset.tab));
      if (btn.dataset.tab === 'roulette') window.RouletteUI.resize();
    });
  });

  // ---------- arranque ----------

  function startApp(user) {
    $('#auth-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#username').textContent = user.username;
    setCredits(user.credits);

    socket = io();
    socket.on('balance', ({ credits: value }) => setCredits(value));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') location.reload();
    });
    socket.on('disconnect', () => toast('Conexión perdida, reconectando…', 'error'));

    const ctx = { socket, emit, toast, renderChips, user };
    window.RouletteUI.init(ctx);
    window.BlackjackUI.init(ctx);
  }

  api('/api/me').then((data) => startApp(data.user)).catch(showAuth);
})();
