'use strict';

window.RouletteUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const COLORS = { red: ['#dc3a42', '#8f1820'], black: ['#34383e', '#0c0e10'], green: ['#1fb566', '#0a6534'] };
  const COLOR_NAME = { red: 'Rojo', black: 'Negro', green: 'Cero' };
  const TAU = Math.PI * 2;
  const SEG = TAU / 37;
  const PHASE_LABEL = { betting: 'Hagan sus apuestas', spinning: 'No va más', result: 'Resultado' };
  const IDLE_SPEED = 0.2; // rad/s de la rueda en reposo
  const SPIN_SPEED = 2.8; // rad/s de la rueda al lanzar la bola
  const BALL_TURNS = 7; // vueltas mínimas de la bola antes de caer
  const DROP_AT = 0.78; // fracción del giro en la que la bola cae en la casilla

  const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
  const betKey = (type, value) => `${type}:${value ?? ''}`;

  // Misma lógica que BET_TYPES en src/roulette.js; aquí solo sirve para resaltar la mesa.
  const WINS = {
    straight: (v, n) => n === v,
    dozen: (v, n) => n !== 0 && Math.ceil(n / 12) === v,
    column: (v, n) => n !== 0 && ((n - 1) % 3) + 1 === v,
    red: (_, n) => colorOf(n) === 'red',
    black: (_, n) => colorOf(n) === 'black',
    even: (_, n) => n !== 0 && n % 2 === 0,
    odd: (_, n) => n % 2 === 1,
    low: (_, n) => n >= 1 && n <= 18,
    high: (_, n) => n >= 19,
  };

  let ctx;
  let canvas;
  let g;
  let size = 0;
  let layers = null; // { bowl, disc }: partes fijas y giratorias pintadas una sola vez
  let wheelAngle = 0;
  let lastFrame = 0;
  let spin = null;
  let ballIdx = null; // casilla (índice en ORDER) donde descansa la bola
  let state = null;
  let deadline = 0;
  let chip = 1;
  let historyKey = '';
  const cells = new Map(); // betKey -> { el, stake, type, value }

  // ---------- rueda ----------

  function geometry() {
    const c = size / 2;
    const R = c - 2;
    return {
      c,
      R,
      rim: R * 0.93, // borde interior de la madera
      track: R * 0.865, // pista por la que rueda la bola
      ring: R * 0.8, // borde exterior de las casillas
      numIn: R * 0.67, // fin de la franja de números
      pocketIn: R * 0.6, // borde interior de las casillas
      pocket: R * 0.635, // donde descansa la bola
      ball: R * 0.034,
    };
  }

  function annulus(lg, c, outer, inner, a0 = 0, a1 = TAU) {
    lg.beginPath();
    lg.arc(c, c, outer, a0, a1);
    lg.arc(c, c, inner, a1, a0, true);
    lg.closePath();
  }

  function goldStroke(lg, c, r, width) {
    const grad = lg.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#fbe7a6');
    grad.addColorStop(0.5, '#a9832b');
    grad.addColorStop(1, '#f3d98b');
    lg.beginPath();
    lg.arc(c, c, r, 0, TAU);
    lg.strokeStyle = grad;
    lg.lineWidth = width;
    lg.stroke();
  }

  function paintBowl(lg, G) {
    const { c, R } = G;
    let grad = lg.createRadialGradient(c, c, G.rim, c, c, R);
    grad.addColorStop(0, '#2a1409');
    grad.addColorStop(0.35, '#834b24');
    grad.addColorStop(0.7, '#5a3016');
    grad.addColorStop(1, '#241006');
    lg.beginPath();
    lg.arc(c, c, R, 0, TAU);
    lg.fillStyle = grad;
    lg.fill();
    goldStroke(lg, c, G.rim, R * 0.014);

    grad = lg.createRadialGradient(c, c, G.ring, c, c, G.rim);
    grad.addColorStop(0, '#0f0804');
    grad.addColorStop(0.55, '#3d2616');
    grad.addColorStop(1, '#170c05');
    annulus(lg, c, G.rim - R * 0.007, G.ring);
    lg.fillStyle = grad;
    lg.fill();

    // Reflejo sobre la pista pulida
    lg.beginPath();
    lg.arc(c, c, G.track, Math.PI * 1.05, Math.PI * 1.62);
    lg.strokeStyle = 'rgba(255,255,255,.09)';
    lg.lineWidth = R * 0.05;
    lg.lineCap = 'round';
    lg.stroke();

    // Deflectores dorados
    const dr = G.rim - R * 0.028;
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8 + TAU / 16;
      lg.save();
      lg.translate(c + Math.cos(a) * dr, c + Math.sin(a) * dr);
      lg.rotate(a);
      lg.beginPath();
      lg.moveTo(-R * 0.018, 0);
      lg.lineTo(0, -R * 0.03);
      lg.lineTo(R * 0.018, 0);
      lg.lineTo(0, R * 0.03);
      lg.closePath();
      lg.fillStyle = '#e8c46a';
      lg.fill();
      lg.restore();
    }
  }

  function paintDisc(lg, G) {
    const { c, R } = G;
    ORDER.forEach((n, i) => {
      const mid = i * SEG - Math.PI / 2;
      const [light, dark] = COLORS[colorOf(n)];
      const grad = lg.createRadialGradient(c, c, G.pocketIn, c, c, G.ring);
      grad.addColorStop(0, dark);
      grad.addColorStop(1, light);
      annulus(lg, c, G.ring, G.pocketIn, mid - SEG / 2, mid + SEG / 2);
      lg.fillStyle = grad;
      lg.fill();
    });

    // Casillas: franja interior más oscura
    annulus(lg, c, G.numIn, G.pocketIn);
    lg.fillStyle = 'rgba(0,0,0,.34)';
    lg.fill();

    // Separadores
    lg.strokeStyle = 'rgba(232,196,106,.9)';
    lg.lineWidth = Math.max(1, R * 0.006);
    for (let i = 0; i < 37; i++) {
      const a = i * SEG - Math.PI / 2 - SEG / 2;
      lg.beginPath();
      lg.moveTo(c + Math.cos(a) * G.pocketIn, c + Math.sin(a) * G.pocketIn);
      lg.lineTo(c + Math.cos(a) * G.ring, c + Math.sin(a) * G.ring);
      lg.stroke();
    }
    goldStroke(lg, c, G.ring, R * 0.012);
    goldStroke(lg, c, G.numIn, R * 0.005);
    goldStroke(lg, c, G.pocketIn, R * 0.012);

    // Números
    lg.font = `700 ${Math.round(R * 0.068)}px 'Inter Variable', system-ui, sans-serif`;
    lg.textAlign = 'center';
    lg.textBaseline = 'middle';
    lg.fillStyle = '#fff';
    const nr = (G.ring + G.numIn) / 2;
    ORDER.forEach((n, i) => {
      const mid = i * SEG - Math.PI / 2;
      lg.save();
      lg.translate(c + Math.cos(mid) * nr, c + Math.sin(mid) * nr);
      lg.rotate(mid + Math.PI / 2);
      lg.fillText(String(n), 0, 0);
      lg.restore();
    });

    // Cono central de madera
    const cone = lg.createRadialGradient(c - R * 0.12, c - R * 0.14, R * 0.02, c, c, G.pocketIn);
    cone.addColorStop(0, '#a06a37');
    cone.addColorStop(0.45, '#6a3d1b');
    cone.addColorStop(1, '#2c1609');
    lg.beginPath();
    lg.arc(c, c, G.pocketIn - R * 0.006, 0, TAU);
    lg.fillStyle = cone;
    lg.fill();
    for (const r of [0.47, 0.33]) {
      lg.beginPath();
      lg.arc(c, c, R * r, 0, TAU);
      lg.strokeStyle = 'rgba(0,0,0,.22)';
      lg.lineWidth = 1;
      lg.stroke();
    }

    // Torreta dorada
    const gold = lg.createLinearGradient(c - R * 0.36, c - R * 0.36, c + R * 0.36, c + R * 0.36);
    gold.addColorStop(0, '#fbe7a6');
    gold.addColorStop(0.5, '#b8912f');
    gold.addColorStop(1, '#f3d98b');
    lg.strokeStyle = gold;
    lg.fillStyle = gold;
    lg.lineCap = 'round';
    lg.lineWidth = R * 0.028;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const x = c + Math.cos(a) * R * 0.34;
      const y = c + Math.sin(a) * R * 0.34;
      lg.beginPath();
      lg.moveTo(c, c);
      lg.lineTo(x, y);
      lg.stroke();
      lg.beginPath();
      lg.arc(x, y, R * 0.03, 0, TAU);
      lg.fill();
    }
    const knob = lg.createRadialGradient(c - R * 0.03, c - R * 0.03, R * 0.005, c, c, R * 0.08);
    knob.addColorStop(0, '#fff6d6');
    knob.addColorStop(0.5, '#e8c46a');
    knob.addColorStop(1, '#8a6a1f');
    lg.beginPath();
    lg.arc(c, c, R * 0.08, 0, TAU);
    lg.fillStyle = knob;
    lg.fill();
  }

  function makeLayer(paint) {
    const dpr = window.devicePixelRatio || 1;
    const layer = document.createElement('canvas');
    layer.width = layer.height = Math.round(size * dpr);
    const lg = layer.getContext('2d');
    lg.scale(dpr, dpr);
    paint(lg, geometry());
    return layer;
  }

  function resize(force = false) {
    const css = canvas.clientWidth;
    if (!css) return;
    const px = Math.round(css * (window.devicePixelRatio || 1));
    if (!force && css === size && canvas.width === px) return;
    canvas.width = canvas.height = px;
    g.setTransform(px / css, 0, 0, px / css, 0, 0);
    size = css;
    layers = { bowl: makeLayer(paintBowl), disc: makeLayer(paintDisc) };
  }

  const pocketAngle = (wheel, idx) => wheel + idx * SEG - Math.PI / 2;

  /** Ángulo de la rueda durante un giro: arranca rápida y frena hasta la velocidad de reposo. */
  function wheelAt(s, t) {
    const d = s.duration;
    const p = Math.min(t, d) / d;
    return s.from + IDLE_SPEED * t + ((SPIN_SPEED - IDLE_SPEED) * d * (1 - (1 - p) ** 3)) / 3;
  }

  function startSpin(n, durationMs) {
    const idx = ORDER.indexOf(n);
    if (ctx.reducedMotion.matches || !size) {
      spin = null;
      ballIdx = idx;
      return;
    }
    const G = geometry();
    const s = { t0: performance.now(), duration: durationMs / 1000, from: wheelAngle, idx };
    s.drop = s.duration * DROP_AT;
    s.ballStart = ballIdx === null ? -Math.PI / 2 : pocketAngle(wheelAngle, ballIdx);
    s.startR = ballIdx === null ? G.track : G.pocket;
    // La bola gira al revés que la rueda y llega a su casilla justo cuando cae.
    const landing = pocketAngle(wheelAt(s, s.drop), idx);
    s.ballEnd = landing - TAU * Math.ceil((landing - s.ballStart) / TAU) - TAU * BALL_TURNS;
    spin = s;
    ballIdx = null;
    hideResult();
  }

  function ballDuringSpin(s, t, G) {
    if (t < s.drop) {
      const p = t / s.drop;
      const angle = s.ballStart + (s.ballEnd - s.ballStart) * (1 - (1 - p) ** 2.2);
      let r = s.startR + (G.track - s.startR) * Math.min(1, t / 0.35);
      const q = Math.max(0, (p - 0.62) / 0.38); // al final baja en espiral rebotando
      if (q > 0) {
        r = G.track + (G.pocket - G.track) * q * q * (3 - 2 * q) + G.R * 0.028 * Math.abs(Math.sin(q * Math.PI * 3)) * (1 - q);
      }
      return { angle, r };
    }
    const k = t - s.drop;
    const settle = Math.exp(-k * 3.5);
    return {
      angle: pocketAngle(wheelAt(s, t), s.idx) + SEG * 0.35 * Math.sin(k * 11) * settle,
      r: G.pocket + G.R * 0.02 * Math.abs(Math.sin(k * 13)) * settle,
    };
  }

  function drawBall(G, { angle, r }) {
    const x = G.c + Math.cos(angle) * r;
    const y = G.c + Math.sin(angle) * r;
    const b = G.ball;
    g.beginPath();
    g.arc(x + b * 0.35, y + b * 0.5, b, 0, TAU);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fill();
    const grad = g.createRadialGradient(x - b * 0.35, y - b * 0.35, b * 0.1, x, y, b);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.6, '#e4e4e4');
    grad.addColorStop(1, '#8f8f8f');
    g.beginPath();
    g.arc(x, y, b, 0, TAU);
    g.fillStyle = grad;
    g.fill();
  }

  function draw(G, ball, now) {
    const { c } = G;
    g.clearRect(0, 0, size, size);
    g.drawImage(layers.bowl, 0, 0, size, size);
    g.save();
    g.translate(c, c);
    g.rotate(wheelAngle);
    g.drawImage(layers.disc, -c, -c, size, size);
    if (state?.phase === 'result' && !spin && ballIdx !== null) {
      const mid = ballIdx * SEG - Math.PI / 2;
      annulus(g, 0, G.ring, G.pocketIn, mid - SEG / 2, mid + SEG / 2);
      g.strokeStyle = '#f7dc8f';
      g.lineWidth = 2.5;
      g.shadowColor = 'rgba(247,220,143,.95)';
      g.shadowBlur = 12 + 6 * Math.sin(now / 180);
      g.stroke();
      g.shadowBlur = 0;
    }
    g.restore();
    if (ball) drawBall(G, ball);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    if (!size || !layers) return;

    const G = geometry();
    let ball = null;
    if (spin) {
      const t = (now - spin.t0) / 1000;
      wheelAngle = wheelAt(spin, t);
      ball = ballDuringSpin(spin, t, G);
      if (t >= spin.duration) {
        ballIdx = spin.idx;
        spin = null;
        if (state?.phase === 'spinning' || state?.phase === 'result') revealResult(ORDER[ballIdx]);
      }
    } else {
      if (!ctx.reducedMotion.matches) wheelAngle = (wheelAngle + IDLE_SPEED * dt) % TAU;
      if (ballIdx !== null) ball = { angle: pocketAngle(wheelAngle, ballIdx), r: G.pocket };
    }
    if (canvas.offsetParent !== null) draw(G, ball, now);
  }

  function revealResult(n) {
    const el = $('#rl-result');
    el.textContent = n;
    el.className = `wheel-result ${colorOf(n)} show`;
    highlight(n);
  }

  function hideResult() {
    $('#rl-result').classList.remove('show');
  }

  // ---------- tapete ----------

  function addCell(board, { type, value = null, label, col, row, cls = '' }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `cell ${cls}`;
    el.style.gridColumn = col;
    el.style.gridRow = row;
    const lbl = document.createElement('span');
    if (label instanceof Node) lbl.appendChild(label);
    else lbl.textContent = label;
    const stake = document.createElement('span');
    stake.className = 'stake';
    el.append(lbl, stake);
    el.addEventListener('click', () => placeBet(type, value));
    cells.set(betKey(type, value), { el, stake, type, value });
    board.appendChild(el);
  }

  function diamond(color) {
    const d = document.createElement('span');
    d.className = `diamond ${color}`;
    return d;
  }

  function buildBoard() {
    const board = $('#rl-board');
    board.innerHTML = '';
    addCell(board, { type: 'straight', value: 0, label: '0', col: '1', row: '1 / 4', cls: 'green' });
    for (let n = 1; n <= 36; n++) {
      addCell(board, {
        type: 'straight', value: n, label: String(n),
        col: String(Math.ceil(n / 3) + 1), row: String(3 - ((n - 1) % 3)), cls: colorOf(n),
      });
    }
    for (let c = 1; c <= 3; c++) addCell(board, { type: 'column', value: c, label: '2:1', col: '14', row: String(4 - c) });
    ['1-12', '13-24', '25-36'].forEach((label, i) =>
      addCell(board, { type: 'dozen', value: i + 1, label, col: `${2 + i * 4} / span 4`, row: '4' })
    );
    [
      ['low', '1-18'], ['even', 'Par'], ['red', diamond('red')],
      ['black', diamond('black')], ['odd', 'Impar'], ['high', '19-36'],
    ].forEach(([type, label], i) => addCell(board, { type, label, col: `${2 + i * 2} / span 2`, row: '5' }));
  }

  /** Anima una ficha desde la bandeja hasta la casilla apostada. */
  function flyChip(value, target) {
    if (ctx.reducedMotion.matches) return;
    const source = $(`#rl-chips .chip[data-value="${value}"]`);
    if (!source) return;
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `chip chip-${value} chip-fly`;
    el.textContent = value;
    Object.assign(el.style, {
      left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    });
    document.body.appendChild(el);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    el.animate(
      [
        { transform: 'translate(0, 0) scale(1) rotate(0deg)' },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 50}px) scale(.85) rotate(180deg)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.45) rotate(360deg)`, opacity: 0.3 },
      ],
      { duration: 420, easing: 'cubic-bezier(.45,.05,.3,1)' }
    ).onfinish = () => el.remove();
  }

  async function placeBet(type, value) {
    if (state?.phase !== 'betting') return ctx.toast('Las apuestas están cerradas, espera la siguiente ronda');
    const amount = chip;
    const res = await ctx.emit('roulette:bet', { type, value, amount });
    if (!res.ok) return ctx.toast(res.error, 'error');
    flyChip(amount, cells.get(betKey(type, value)).el);
  }

  function renderBets(bets) {
    const amounts = new Map(bets.map((b) => [betKey(b.type, b.value), b.amount]));
    let total = 0;
    for (const [key, { stake }] of cells) {
      const amount = amounts.get(key) ?? 0;
      total += amount;
      const text = amount ? String(amount) : '';
      if (stake.textContent === text) continue;
      stake.textContent = text;
      stake.classList.remove('pop');
      if (amount) {
        void stake.offsetWidth;
        stake.classList.add('pop');
      }
    }
    $('#rl-total').textContent = total;
  }

  function renderHistory(history, animate) {
    const key = history.map((h) => h.number).join(',');
    if (key === historyKey) return;
    historyKey = key;

    const strip = $('#rl-history');
    strip.replaceChildren();
    if (!history.length) strip.textContent = 'Aún no hay giros';
    for (const { number, color } of history) {
      const el = document.createElement('span');
      el.className = `hnum ${color}`;
      el.textContent = number;
      strip.appendChild(el);
    }
    if (animate) strip.firstElementChild?.classList.add('enter');

    const counts = { red: 0, black: 0, green: 0 };
    for (const h of history) counts[h.color]++;
    $('#rl-stats').replaceChildren(
      ...Object.entries(counts).map(([color, count]) => {
        const el = document.createElement('span');
        el.className = `stat ${color}`;
        el.title = COLOR_NAME[color];
        el.textContent = count;
        return el;
      })
    );
  }

  function highlight(n) {
    for (const { el, type, value } of cells.values()) {
      const wins = n !== null && WINS[type](value, n);
      el.classList.toggle('win', wins && type === 'straight');
      el.classList.toggle('win-soft', wins && type !== 'straight');
    }
  }

  function onState(s) {
    const prev = state;
    state = s;
    deadline = Date.now() + s.endsIn;

    if (s.phase === 'spinning' && prev?.phase !== 'spinning') {
      startSpin(s.result, Math.max(800, s.endsIn - 250));
    } else if (s.phase === 'result' && !spin) {
      ballIdx = ORDER.indexOf(s.result);
      revealResult(s.result);
    } else if (s.phase === 'betting') {
      hideResult();
      highlight(null);
      if (ballIdx === null && s.history.length) ballIdx = ORDER.indexOf(s.history[0].number);
      if (prev && prev.phase !== 'betting') $('#rl-outcome').textContent = '';
    }

    $('#rl-board').classList.toggle('closed', s.phase !== 'betting');
    $('#rl-clear').disabled = s.phase !== 'betting';
    $('#rl-phase').textContent = s.phase === 'result' ? `Salió el ${s.result}` : PHASE_LABEL[s.phase];
    renderHistory(s.history, prev?.phase === 'spinning' && s.phase === 'result');
  }

  function onOutcome({ number, staked, won }) {
    const el = $('#rl-outcome');
    const net = won - staked;
    el.className = 'outcome';
    void el.offsetWidth;
    if (won > 0) {
      el.classList.add('win');
      el.textContent = `¡Salió el ${number}! Cobras ${won} créditos (neto ${net >= 0 ? '+' : ''}${net})`;
      if (net > 0) ctx.celebrate(won, `¡${number}! Ganas`, net >= staked * 5);
    } else {
      el.classList.add('lose');
      el.textContent = `Salió el ${number}. Pierdes ${staked} créditos`;
    }
  }

  function tick() {
    if (!state) return;
    const left = Math.max(0, deadline - Date.now());
    const secs = Math.ceil(left / 1000);
    const betting = state.phase === 'betting';
    const urgent = betting && secs <= 5;
    const timer = $('#rl-timer');
    timer.textContent = betting ? `${secs}s` : '';
    timer.classList.toggle('urgent', urgent);
    const bar = $('#rl-progress');
    bar.style.width = `${state.duration ? (left / state.duration) * 100 : 0}%`;
    bar.parentElement.classList.toggle('urgent', urgent);
    bar.parentElement.classList.toggle('invisible', !state.duration);
  }

  function init(appCtx) {
    ctx = appCtx;
    canvas = $('#wheel');
    g = canvas.getContext('2d');
    buildBoard();
    ctx.renderChips($('#rl-chips'), (v) => { chip = v; }, true);

    $('#rl-clear').addEventListener('click', async () => {
      const res = await ctx.emit('roulette:clear');
      if (!res.ok) ctx.toast(res.error, 'error');
    });

    ctx.socket.on('roulette:state', onState);
    ctx.socket.on('roulette:bets', renderBets);
    ctx.socket.on('roulette:outcome', onOutcome);

    window.addEventListener('resize', () => resize());
    resize();
    // Los números se vuelven a pintar cuando carga la fuente.
    document.fonts?.ready.then(() => resize(true));
    requestAnimationFrame(frame);
    setInterval(tick, 100);
  }

  return { init, resize };
})();
