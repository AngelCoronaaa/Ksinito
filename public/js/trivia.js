'use strict';

// Trivia: ruleta de categorías + 8 preguntas. El servidor elige categoría, pregunta y orden de
// las opciones, y solo dice cuál era la correcta después de responder. Aquí solo se dibuja:
// cada `trivia:round` trae la partida entera y la pantalla se construye a partir de ella.
window.TriviaUI = (() => {
  const $ = (sel) => document.querySelector(sel);

  // Aspecto de cada categoría (el nombre y el orden llegan del servidor en trivia:config).
  const LOOK = {
    ciencia: { color: '#1fae6a', icon: 'bi-lightbulb-fill' },
    geografia: { color: '#2f86e8', icon: 'bi-globe-americas' },
    historia: { color: '#e9b322', icon: 'bi-hourglass-split' },
    cine: { color: '#d93a8c', icon: 'bi-film' },
    arte: { color: '#cf3131', icon: 'bi-palette-fill' },
    deportes: { color: '#ee7a16', icon: 'bi-trophy-fill' },
    // Modo Tecnología
    hardware: { color: '#4f7cff', icon: 'bi-cpu-fill' },
    software: { color: '#9b5cf6', icon: 'bi-window-stack' },
    sistemas: { color: '#13a8a0', icon: 'bi-terminal-fill' },
    internet: { color: '#1fa3e0', icon: 'bi-wifi' },
    programacion: { color: '#f2a52b', icon: 'bi-code-slash' },
    empresas: { color: '#e5487a', icon: 'bi-building-fill' },
  };
  const MODE_ICON = { clasica: 'bi-stars', tecnologia: 'bi-motherboard-fill' };
  const MODE_KEY = 'ksinito.trivia.mode'; // último modo elegido (solo comodidad, en este navegador)
  const LETTERS = ['A', 'B', 'C', 'D'];
  const REVEAL_MS = 1_800; // la última respuesta se ve un momento antes del resumen

  let ctx;
  let config = null;
  let round = null; // última partida recibida
  let view = 'lobby'; // lobby | game | summary
  let pending = 0; // apuesta que se está preparando
  let lastBet = 0;
  let wheelAngle = 0; // giro acumulado de la ruleta (grados)
  let spunKey = null; // "partida:pregunta" del último giro animado
  let optionsKey = null; // "partida:pregunta" de las opciones dibujadas
  let picked = null; // opción pulsada, a la espera del servidor
  let busy = false; // esperando la respuesta a "girar"
  let starting = false; // esperando la respuesta a "jugar"
  let clock = 0; // requestAnimationFrame de la cuenta atrás
  let summaryTimer = 0;
  let firstResume = true;
  let mode = null; // modo elegido para la próxima partida
  let wheelMode = null; // modo cuyas categorías tiene ahora la ruleta

  const fmt = (n) => n.toLocaleString('es');
  const modeOf = (id) => config.modes.find((m) => m.id === id) ?? config.modes[0];
  const maxBet = () => modeOf(mode).max ?? config.max; // límite del modo elegido
  const nameOf = (id) => config?.modes.flatMap((m) => m.categories).find((c) => c.id === id)?.name ?? id;
  const xLabel = (m) => `×${m.toLocaleString('es')}`;

  // ---------- ruleta ----------

  /** Pone en la ruleta las categorías del modo (si ya las tiene, no hace nada). */
  function buildWheel(modeId) {
    if (modeId === wheelMode) return;
    wheelMode = modeId;
    const wheel = $('#tv-wheel');
    const cats = modeOf(modeId).categories;
    const slice = 360 / cats.length;
    wheel.style.background = `conic-gradient(${cats
      .map((c, i) => `${LOOK[c.id]?.color ?? '#555'} ${i * slice}deg ${(i + 1) * slice}deg`)
      .join(', ')})`;
    wheel.replaceChildren(
      ...cats.map((c, i) => {
        const seg = document.createElement('div');
        seg.className = 'tv-seg';
        seg.style.setProperty('--a', `${i * slice + slice / 2}deg`);
        seg.innerHTML = `<i class="bi ${LOOK[c.id]?.icon ?? 'bi-question-lg'}"></i><span></span>`;
        seg.querySelector('span').textContent = c.name;
        return seg;
      })
    );
  }

  /** Gira la ruleta hasta dejar la categoría bajo la flecha en `ms` (0 = sin animación). */
  function spinTo(categoryId, ms) {
    const cats = modeOf(wheelMode).categories;
    const slice = 360 / cats.length;
    const i = Math.max(0, cats.findIndex((c) => c.id === categoryId));
    const jitter = (Math.random() - 0.5) * slice * 0.6; // no siempre en el centro exacto
    const target = (((-(i * slice + slice / 2) + jitter) % 360) + 360) % 360;
    const current = ((wheelAngle % 360) + 360) % 360;
    const turns = ms > 1_200 ? 4 : ms > 0 ? 1 : 0;
    wheelAngle += turns * 360 + ((target - current + 360) % 360);
    const wheel = $('#tv-wheel');
    const animate = ms > 0 && !ctx.reducedMotion.matches;
    // Si la ruleta acaba de dejar de estar oculta, el navegador necesita su estilo actual
    // antes del nuevo giro; si no, salta al final sin animarse.
    void wheel.offsetWidth;
    wheel.style.transition = animate ? `transform ${ms}ms cubic-bezier(.15, .72, .12, 1)` : 'none';
    wheel.style.transform = `rotate(${wheelAngle}deg)`;
  }

  // ---------- apuesta ----------

  function renderPays() {
    const bet = pending || lastBet || config.min;
    $('#tv-pays').replaceChildren(
      ...config.multipliers.map(({ correct, multiplier }) => {
        const row = document.createElement('div');
        row.className = 'tv-pay';
        row.innerHTML = '<span class="tv-pay-hits"></span><span class="tv-pay-x"></span><span class="tv-pay-amount"></span>';
        row.querySelector('.tv-pay-hits').textContent = `${correct}/${config.questions}`;
        row.querySelector('.tv-pay-x').textContent = xLabel(multiplier);
        row.querySelector('.tv-pay-amount').textContent = fmt(Math.floor(bet * multiplier));
        return row;
      }),
      Object.assign(document.createElement('div'), {
        className: 'tv-pay lose',
        textContent: `Menos de ${Math.min(...config.multipliers.map((m) => m.correct))}: pierdes la apuesta`,
      })
    );
  }

  function renderPending() {
    $('#tv-pending').textContent = fmt(pending);
    $('#tv-play').disabled = starting || pending < config.min;
    renderPays();
  }

  async function play() {
    if (starting || pending < config.min) return;
    starting = true;
    renderPending();
    const amount = pending;
    const res = await ctx.emit('trivia:start', { amount, mode });
    starting = false;
    if (!res.ok) {
      ctx.toast(res.error, 'error');
      renderPending();
      return;
    }
    lastBet = amount;
    renderPending();
  }

  // ---------- partida ----------

  function show(next) {
    view = next;
    for (const [name, id] of [['lobby', '#tv-lobby'], ['game', '#tv-game'], ['summary', '#tv-summary']]) {
      $(id).classList.toggle('hidden', name !== next);
    }
    if (next !== 'game') {
      stopClock();
      $('#trivia').dataset.phase = next;
    }
    if (next === 'lobby') {
      if (config) buildWheel(mode);
      $('#tv-spin').disabled = true;
      $('#tv-hint').textContent = 'Apuesta para empezar';
      renderSteps(null);
    }
  }

  function renderSteps(r) {
    const total = r?.total ?? config?.questions ?? 5;
    const steps = Array.from({ length: total }, (_, i) => {
      const el = document.createElement('span');
      el.className = 'tv-step';
      el.setAttribute('role', 'listitem');
      const done = r?.results[i];
      const isCurrent = r && !done && i === r.results.length && ['spinning', 'question'].includes(r.phase);
      const category = done?.category ?? (isCurrent && r.phase === 'question' ? r.category : null);
      if (category) el.style.setProperty('--c', LOOK[category]?.color);
      if (done) {
        el.classList.add(done.correct ? 'ok' : 'bad');
        el.innerHTML = `<i class="bi ${done.correct ? 'bi-check-lg' : 'bi-x-lg'}"></i>`;
        el.setAttribute('aria-label', `Pregunta ${i + 1}: ${done.correct ? 'acierto' : 'fallo'} (${nameOf(done.category)})`);
      } else {
        el.textContent = String(i + 1);
        el.setAttribute('aria-label', `Pregunta ${i + 1}`);
        if (isCurrent) el.classList.add('current');
      }
      return el;
    });
    $('#tv-steps').replaceChildren(...steps);
  }

  function renderCategory(r) {
    const el = $('#tv-category');
    if (!r.category || r.phase === 'spinning') {
      el.className = 'tv-category muted';
      el.textContent = r.phase === 'spinning' ? 'Girando…' : 'Gira la ruleta';
      return;
    }
    el.className = 'tv-category';
    el.style.setProperty('--c', LOOK[r.category]?.color);
    el.innerHTML = `<i class="bi ${LOOK[r.category]?.icon ?? 'bi-question-lg'}"></i><span></span>`;
    el.querySelector('span').textContent = nameOf(r.category);
  }

  function renderOptions(r) {
    const key = `${r.roundId}:${r.number}`;
    const box = $('#tv-options');
    if (!r.question) {
      box.replaceChildren();
      $('#tv-question').textContent = '';
      optionsKey = null;
      return;
    }
    if (optionsKey !== key) {
      optionsKey = key;
      picked = null;
      $('#tv-question').textContent = r.question.text;
      box.replaceChildren(
        ...r.question.options.map((text, i) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tv-opt';
          btn.dataset.index = i;
          btn.innerHTML = '<span class="tv-letter"></span><span class="tv-opt-text"></span>';
          btn.querySelector('.tv-letter').textContent = LETTERS[i];
          btn.querySelector('.tv-opt-text').textContent = text;
          btn.addEventListener('click', () => answer(i));
          return btn;
        })
      );
      if (!ctx.reducedMotion.matches) {
        box.classList.remove('enter');
        void box.offsetWidth; // reinicia la animación
        box.classList.add('enter');
      }
    }
    const answered = r.last && (r.phase === 'answered' || r.phase === 'finished');
    box.querySelectorAll('.tv-opt').forEach((btn, i) => {
      btn.disabled = r.phase !== 'question' || picked !== null;
      btn.classList.toggle('picked', picked === i && !answered);
      btn.classList.toggle('right', !!answered && i === r.last.correctIndex);
      btn.classList.toggle('wrong', !!answered && i === r.last.choice && !r.last.correct);
      btn.classList.toggle('faded', !!answered && i !== r.last.correctIndex && i !== r.last.choice);
    });
  }

  function renderFeedback(r) {
    const el = $('#tv-feedback');
    el.className = 'tv-feedback';
    if (r.phase === 'answered' || r.phase === 'finished') {
      const { correct, timedOut } = r.last;
      el.textContent = correct ? '¡Correcto!' : timedOut ? '¡Se acabó el tiempo!' : 'Incorrecto';
      el.classList.add(correct ? 'ok' : 'bad');
    } else if (r.phase === 'ready') {
      el.textContent = 'Pulsa GIRAR para la primera pregunta';
    } else {
      el.textContent = '';
    }
  }

  function stopClock() {
    cancelAnimationFrame(clock);
    clock = 0;
  }

  /** Cuenta atrás: de la pregunta (barra) o del giro automático (texto bajo la ruleta). */
  function startClock(r) {
    stopClock();
    const endsAt = performance.now() + r.endsIn;
    const questionPhase = r.phase === 'question';
    $('#tv-clock').classList.toggle('hidden', !questionPhase);
    let lastSecond = null;
    const tick = () => {
      const left = Math.max(0, endsAt - performance.now());
      const seconds = Math.ceil(left / 1000);
      if (questionPhase) {
        $('#tv-progress').style.width = `${(left / r.duration) * 100}%`;
        if (seconds !== lastSecond) {
          $('#tv-seconds').textContent = `${seconds} s`;
          const urgent = seconds <= 3;
          $('#tv-seconds').classList.toggle('urgent', urgent);
          $('#tv-clock .phase-progress').classList.toggle('urgent', urgent);
        }
      } else if (seconds !== lastSecond && (r.phase === 'ready' || r.phase === 'answered')) {
        $('#tv-hint').textContent = seconds <= 10 ? `Gira sola en ${seconds} s` : 'Pulsa GIRAR';
      }
      lastSecond = seconds;
      if (left > 0) clock = requestAnimationFrame(tick);
    };
    tick();
  }

  function render(r) {
    round = r;
    // Antes de girar: en móvil la ruleta vuelve a mostrarse con esto (ver spinTo).
    $('#trivia').dataset.phase = r.phase;
    $('#tv-number').textContent = `Pregunta ${Math.min(Math.max(r.number, 1), r.total)} de ${r.total}`;
    $('#tv-stake').textContent = fmt(r.bet);
    renderSteps(r);
    renderCategory(r);
    renderOptions(r);
    renderFeedback(r);

    buildWheel(r.mode); // p. ej. una partida de Tecnología empezada en otra pestaña
    const key = `${r.roundId}:${r.number}`;
    if (r.phase === 'spinning' && spunKey !== key) {
      spunKey = key;
      spinTo(r.category, r.endsIn);
    } else if (r.category && r.phase !== 'ready' && spunKey !== key) {
      spunKey = key; // p. ej. al recargar con la pregunta ya en pantalla
      spinTo(r.category, 0);
    }

    const canSpin = r.phase === 'ready' || r.phase === 'answered';
    $('#tv-next').classList.toggle('hidden', !canSpin);
    $('#tv-next').disabled = busy;
    $('#tv-spin').disabled = !canSpin || busy;
    $('#tv-spin').classList.toggle('ready', canSpin);
    if (r.phase === 'spinning') $('#tv-hint').textContent = 'Girando…';
    else if (r.phase === 'question') {
      $('#tv-hint').textContent = r.results.length
        ? `Llevas ${r.correct} acierto${r.correct === 1 ? '' : 's'} de ${r.results.length}`
        : 'Responde antes de que se acabe el tiempo';
    }
    else if (r.phase === 'finished') $('#tv-hint').textContent = '';

    if (r.phase === 'finished') stopClock();
    else startClock(r);
    if (r.phase !== 'question') $('#tv-clock').classList.add('hidden');
  }

  async function spin() {
    if (!round || busy) return;
    busy = true;
    $('#tv-spin').disabled = true;
    $('#tv-next').disabled = true;
    const res = await ctx.emit('trivia:spin', { roundId: round.roundId });
    busy = false;
    if (!res.ok) {
      ctx.toast(res.error, 'error');
      if (round) render(round);
    }
  }

  async function answer(index) {
    if (!round || round.phase !== 'question' || picked !== null) return;
    picked = index;
    renderOptions(round);
    const res = await ctx.emit('trivia:answer', { roundId: round.roundId, choice: index });
    if (!res.ok) {
      ctx.toast(res.error, 'error');
      picked = null;
      if (round) renderOptions(round);
    }
  }

  function onRound(r) {
    const first = firstResume;
    firstResume = false;
    if (!r) {
      // Sin partida en juego (p. ej. al reconectar después de que terminara).
      if (view === 'game' && round?.phase !== 'finished') show('lobby');
      return;
    }
    clearTimeout(summaryTimer);
    if (view !== 'game') show('game');
    render(r);
    // Al abrir la página con una partida a medias, se va directo a ella.
    if (first && $('#trivia').classList.contains('hidden')) $('.tabs [data-tab="trivia"]').click();
  }

  function onEnd(end) {
    if (round?.roundId !== end.roundId) return;
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => showSummary(end), ctx.reducedMotion.matches ? 600 : REVEAL_MS);
  }

  function showSummary(end) {
    show('summary');
    renderSteps(round);
    $('#tv-hint').textContent = '';
    $('#tv-spin').disabled = true;
    $('#tv-spin').classList.remove('ready');
    const won = end.payout > 0;
    $('#tv-score').textContent = `${end.correct}/${end.total}`;
    $('#tv-score').className = `tv-score ${won ? 'ok' : 'bad'}`;
    const result = $('#tv-result');
    result.className = `tv-result ${won ? 'ok' : 'bad'}`;
    if (end.error) {
      result.textContent = 'No se pudo cobrar';
      $('#tv-result-detail').textContent = 'Hubo un error al pagar la partida. Inténtalo de nuevo más tarde.';
    } else if (won) {
      result.textContent = `${xLabel(end.multiplier)} · +${fmt(end.payout)}`;
      $('#tv-result-detail').textContent = `Apostaste ${fmt(end.bet)} y cobras ${fmt(end.payout)}.`;
      const perfect = end.correct === end.total;
      ctx.celebrate({
        amount: end.payout,
        net: end.payout - end.bet,
        title: perfect ? '¡Perfecto!' : null,
        detail: `Trivia ${modeOf(end.mode).name} · ${end.correct}/${end.total} aciertos · ${xLabel(end.multiplier)}`,
        big: perfect,
      });
    } else {
      result.textContent = `−${fmt(end.bet)}`;
      const needed = Math.min(...config.multipliers.map((m) => m.correct));
      $('#tv-result-detail').textContent = `Necesitas al menos ${needed} aciertos para cobrar.`;
    }
    round = null;
    lastBet = end.bet;
    pending = Math.min(lastBet, maxBet());
    renderPending();
  }

  /** Selector de modo de la pantalla de apuesta. */
  function renderModes() {
    $('#tv-modes').replaceChildren(
      ...config.modes.map((m) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tv-mode tv-mode-${m.id}`;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(m.id === mode));
        btn.classList.toggle('active', m.id === mode);
        btn.innerHTML = `<i class="bi ${MODE_ICON[m.id] ?? 'bi-question-circle'}"></i><span class="tv-mode-name"></span><span class="tv-mode-desc"></span>`;
        btn.querySelector('.tv-mode-name').textContent = m.name;
        btn.querySelector('.tv-mode-desc').textContent = m.description;
        btn.addEventListener('click', () => setMode(m.id));
        return btn;
      })
    );
    $('#tv-title-mode').textContent = modeOf(mode).name;
    $('#tv-limits').textContent = `Mínimo ${fmt(config.min)} · máximo ${fmt(maxBet())}`;
  }

  function setMode(id) {
    mode = modeOf(id).id;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    renderModes();
    if (view !== 'game') buildWheel(mode);
    // Al pasar a un modo con límite menor, la apuesta preparada se ajusta.
    if (pending > maxBet()) pending = maxBet();
    if (lastBet > maxBet()) lastBet = maxBet();
    renderPending();
  }

  function onConfig(c) {
    const first = !config;
    config = c;
    let saved = null;
    try {
      saved = localStorage.getItem(MODE_KEY);
    } catch {}
    mode = modeOf(mode ?? saved ?? c.defaultMode).id;
    renderModes();
    buildWheel(round?.mode ?? mode);
    if (first) {
      ctx.renderChips($('#tv-chips'), (v) => {
        pending = Math.min(maxBet(), pending + v);
        renderPending();
      }, false, c.min);
      // All-in: todo el saldo, hasta el máximo de la trivia.
      const allIn = document.createElement('button');
      allIn.type = 'button';
      allIn.className = 'chip chip-allin';
      allIn.textContent = 'ALL-IN';
      allIn.setAttribute('aria-label', 'Apostar todo tu saldo');
      allIn.addEventListener('click', () => {
        const all = Math.min(maxBet(), ctx.credits() ?? 0);
        if (all < config.min) {
          ctx.toast(`Necesitas al menos ${fmt(config.min)} créditos para jugar`, 'error');
          return;
        }
        pending = all;
        renderPending();
      });
      $('#tv-chips').appendChild(allIn);
    }
    renderPending();
    if (view === 'lobby') show('lobby');
  }

  function init(appCtx) {
    ctx = appCtx;
    $('#tv-spin').addEventListener('click', spin);
    $('#tv-next').addEventListener('click', spin);
    $('#tv-play').addEventListener('click', play);
    $('#tv-bet-clear').addEventListener('click', () => {
      pending = 0;
      renderPending();
    });
    $('#tv-again').addEventListener('click', () => show('lobby'));
    // La pregunta y las opciones no se pueden seleccionar ni copiar (para no pegarlas en un
    // buscador). Con una pregunta en pantalla, tampoco se copia nada de la página.
    for (const type of ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart']) {
      $('#tv-game').addEventListener(type, (e) => e.preventDefault());
    }
    document.addEventListener('copy', (e) => {
      if (round?.phase !== 'question') return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', '');
    });
    // Atajos: 1-4 o A-D para responder mientras la trivia está a la vista.
    document.addEventListener('keydown', (e) => {
      if ($('#trivia').classList.contains('hidden') || e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toUpperCase();
      const index = ['1', '2', '3', '4'].includes(key) ? Number(key) - 1 : LETTERS.indexOf(key);
      if (index >= 0 && round?.phase === 'question') answer(index);
    });
    ctx.socket.on('trivia:config', onConfig);
    ctx.socket.on('trivia:round', onRound);
    ctx.socket.on('trivia:end', onEnd);
    // Al conectar (y al reconectar) se recupera la partida en juego, si la hay.
    ctx.socket.on('connect', () => ctx.emit('trivia:resume'));
  }

  return { init };
})();
