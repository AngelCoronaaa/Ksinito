'use strict';

window.RouletteUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const COLORS = { red: '#b3261e', black: '#1b1b1b', green: '#0d7a3e' };
  const TAU = Math.PI * 2;
  const SEG = TAU / 37;
  const PHASE_LABEL = { betting: 'Hagan sus apuestas', spinning: 'No va más', result: 'Resultado' };

  const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
  const betKey = (type, value) => `${type}:${value ?? ''}`;

  let ctx;
  let canvas;
  let g;
  let size = 0;
  let rotation = 0;
  let showBall = false;
  let anim = null;
  let state = null;
  let deadline = 0;
  let chip = 1;
  const cells = new Map();

  // ---------- rueda ----------

  function resize() {
    const css = canvas.clientWidth;
    if (!css) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = css;
    draw();
  }

  function draw() {
    if (!size) return;
    const c = size / 2;
    const R = c - 2;
    const outer = R * 0.9;
    const inner = R * 0.6;
    g.clearRect(0, 0, size, size);

    g.beginPath();
    g.arc(c, c, R, 0, TAU);
    g.fillStyle = '#4a2c16';
    g.fill();

    g.font = `700 ${Math.round(R * 0.075)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    ORDER.forEach((n, i) => {
      const mid = rotation + i * SEG - Math.PI / 2;
      g.beginPath();
      g.arc(c, c, outer, mid - SEG / 2, mid + SEG / 2);
      g.arc(c, c, inner, mid + SEG / 2, mid - SEG / 2, true);
      g.closePath();
      g.fillStyle = COLORS[colorOf(n)];
      g.fill();
      g.strokeStyle = 'rgba(217,180,74,.7)';
      g.lineWidth = 1;
      g.stroke();

      const tr = outer - (outer - inner) * 0.28;
      g.save();
      g.translate(c + Math.cos(mid) * tr, c + Math.sin(mid) * tr);
      g.rotate(mid + Math.PI / 2);
      g.fillStyle = '#fff';
      g.fillText(String(n), 0, 0);
      g.restore();
    });

    const hub = g.createRadialGradient(c, c, 0, c, c, inner);
    hub.addColorStop(0, '#2b7a4b');
    hub.addColorStop(1, '#0a3f26');
    g.beginPath();
    g.arc(c, c, inner, 0, TAU);
    g.fillStyle = hub;
    g.fill();
    g.beginPath();
    g.arc(c, c, inner * 0.25, 0, TAU);
    g.fillStyle = '#d9b44a';
    g.fill();

    if (showBall) {
      const br = outer - (outer - inner) * 0.72;
      g.beginPath();
      g.arc(c, c - br, R * 0.035, 0, TAU);
      g.fillStyle = '#fff';
      g.shadowColor = 'rgba(0,0,0,.6)';
      g.shadowBlur = 4;
      g.fill();
      g.shadowBlur = 0;
    }
  }

  function setTo(n) {
    cancelAnimationFrame(anim);
    rotation = -ORDER.indexOf(n) * SEG;
    showBall = true;
    draw();
  }

  function spinTo(n, duration) {
    cancelAnimationFrame(anim);
    const from = rotation;
    const target = -ORDER.indexOf(n) * SEG;
    const delta = (((target - from) % TAU) + TAU) % TAU;
    const to = from + delta + TAU * 5;
    const t0 = performance.now();
    showBall = false;
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      rotation = from + (to - from) * (1 - Math.pow(1 - p, 4));
      if (p < 1) {
        draw();
        anim = requestAnimationFrame(frame);
      } else {
        rotation = to % TAU;
        showBall = true;
        draw();
      }
    };
    anim = requestAnimationFrame(frame);
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
    cells.set(betKey(type, value), el);
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

  async function placeBet(type, value) {
    if (state?.phase !== 'betting') return ctx.toast('Las apuestas están cerradas, espera la siguiente ronda');
    const res = await ctx.emit('roulette:bet', { type, value, amount: chip });
    if (!res.ok) ctx.toast(res.error, 'error');
  }

  function renderBets(bets) {
    for (const el of cells.values()) el.querySelector('.stake').textContent = '';
    let total = 0;
    for (const bet of bets) {
      total += bet.amount;
      const el = cells.get(betKey(bet.type, bet.value));
      if (el) el.querySelector('.stake').textContent = bet.amount;
    }
    $('#rl-total').textContent = total;
  }

  function renderHistory(history) {
    const strip = $('#rl-history');
    strip.innerHTML = '';
    if (!history.length) strip.textContent = 'Aún no hay giros';
    for (const { number, color } of history) {
      const el = document.createElement('span');
      el.className = `hnum ${color}`;
      el.textContent = number;
      strip.appendChild(el);
    }
  }

  function highlight(n) {
    for (const el of cells.values()) el.classList.remove('win');
    if (n !== null) cells.get(betKey('straight', n))?.classList.add('win');
  }

  function onState(s) {
    const prev = state;
    state = s;
    deadline = Date.now() + s.endsIn;

    if (s.phase === 'spinning' && prev?.phase !== 'spinning') {
      spinTo(s.result, Math.max(800, s.endsIn - 250));
    } else if (s.phase === 'result') {
      if (prev?.phase !== 'spinning') setTo(s.result);
      highlight(s.result);
    } else if (s.phase === 'betting') {
      highlight(null);
      if (!prev && s.history.length) setTo(s.history[0].number);
      if (prev && prev.phase !== 'betting') $('#rl-outcome').textContent = '';
    }

    $('#rl-board').classList.toggle('closed', s.phase !== 'betting');
    $('#rl-clear').disabled = s.phase !== 'betting';
    $('#rl-phase').textContent = s.phase === 'result' ? `Salió el ${s.result}` : PHASE_LABEL[s.phase];
    renderHistory(s.history);
  }

  function onOutcome({ number, staked, won }) {
    const el = $('#rl-outcome');
    if (won > 0) {
      el.className = 'outcome win';
      el.textContent = `¡Salió el ${number}! Cobras ${won} créditos (neto ${won - staked >= 0 ? '+' : ''}${won - staked})`;
    } else {
      el.className = 'outcome lose';
      el.textContent = `Salió el ${number}. Pierdes ${staked} créditos`;
    }
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

    window.addEventListener('resize', resize);
    resize();
    setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      $('#rl-timer').textContent = state?.phase === 'betting' ? `${left}s` : '';
    }, 200);
  }

  return { init, resize };
})();
