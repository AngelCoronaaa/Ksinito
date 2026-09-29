'use strict';

// Minijuego "Patos" (ver src/ducks.js). Aquí solo se dibuja y se envían disparos ("disparé en
// (x, y) en el instante t"): el servidor decide qué patos hay, dónde están y si un disparo
// acierta. Un pato solo cae cuando llega ducks:shotResult con hit: true; antes, como mucho, se
// pinta un destello provisional. Los patos se mueven con la misma duckPosition() que usa el
// servidor (duck-path.js), sobre el reloj de la ronda sincronizado con el del servidor.
//
// Todo el arte se dibuja en canvas y los sonidos se generan con Web Audio API.
window.DucksUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => n.toLocaleString('es');
  const script = document.currentScript;
  // Con la misma versión (?v=) que este archivo, para no mezclar código de dos deploys.
  const trackReady = import(new URL(`duck-path.js${new URL(script.src).search}`, script.src).href);

  const TAU = Math.PI * 2;
  const MAX_DPR = 2; // más resolución no se nota y cuesta en móviles
  const DUCK_SCALE = 0.0009; // tamaño del pato (dibujado en unas 130 unidades de largo)
  const FRONT_TOP = 0.5; // la capa de delante (pasto y juncos) empieza aquí
  const FALL_PAUSE_MS = 320; // el pato se queda quieto un momento al recibir el disparo
  const RESUME_THROTTLE_MS = 2000;
  const MUTE_KEY = 'ksinito:ducks-muted';
  const GREAT_ROUND = 8; // confeti con 8 o más patos
  const PALETTES = [
    { body: '#9b87d6', belly: '#e3dafa', head: '#7058c0', wing: '#5f4aa8' }, // lavanda
    { body: '#34b5a0', belly: '#c4f1e6', head: '#1d8a7b', wing: '#177264' }, // turquesa
    { body: '#f0826b', belly: '#ffd9cc', head: '#d65d4b', wing: '#b4483a' }, // coral
  ];

  let ctx;
  let track = null; // duck-path.js
  let ASPECT = 16 / 9;

  let canvas;
  let g;
  let W = 0; // tamaño del canvas en píxeles reales
  let H = 0;
  let layers = null; // { back, front, frontY }: fondo y primer plano ya pintados
  let active = false; // se está viendo la sección
  let raf = 0;

  let status = null; // último /api/ducks/status
  let round = null; // ronda en juego
  let clockStart = 0; // performance.now() del instante 0 de la ronda
  let lastShotT = 0;
  const pending = new Set(); // `t` de los disparos sin respuesta
  const ducks = new Map(); // duckId -> pato que se dibuja
  let effects = [];
  let lastResults = []; // casillas de la última ronda, para dejarlas a la vista
  let result = null; // resultado de la última ronda (pantalla final)
  let cooldownEnd = 0;
  let resetEnd = 0;
  let countdown = 0;
  let starting = false;
  let resumedAt = 0;
  let firstRound = true;
  let pointer = null; // posición del ratón (normalizada) para dibujar la mira
  let bannerTimer = 0;
  let muted = false;

  const span = (cls, text = '') => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const roundT = (now = performance.now()) => now - clockStart;
  const mine = (roundId) => round !== null && round.id === roundId;
  const earned = () => (round ? Math.min(round.hits * round.reward, round.maxReward) : 0);
  const cardShown = () => !$('#dk-card').classList.contains('hidden');

  // ---------- sonido (Web Audio, sin archivos) ----------

  let audio = null;
  let master = null;
  let noiseBuffer = null;

  function audioCtx() {
    if (muted) return null;
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
      master = audio.createGain();
      master.gain.value = 0.45;
      master.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }

  function envelope(gain, t0, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function tone(a, { type = 'sine', from, to = from, at = 0, dur, peak = 0.3, filter = null }) {
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const gain = a.createGain();
    envelope(gain, t0, peak, 0.008, dur);
    let node = osc;
    if (filter) {
      const f = a.createBiquadFilter();
      f.type = filter.type;
      f.frequency.value = filter.freq;
      f.Q.value = filter.q ?? 1;
      node = node.connect(f);
    }
    node.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const sfx = {
    shot() {
      const a = audioCtx();
      if (!a) return;
      if (!noiseBuffer) {
        noiseBuffer = a.createBuffer(1, Math.round(a.sampleRate * 0.35), a.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const t0 = a.currentTime;
      const src = a.createBufferSource();
      src.buffer = noiseBuffer;
      const f = a.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(5000, t0);
      f.frequency.exponentialRampToValueAtTime(260, t0 + 0.22);
      const gain = a.createGain();
      envelope(gain, t0, 0.8, 0.002, 0.24);
      src.connect(f).connect(gain).connect(master);
      src.start(t0);
      src.stop(t0 + 0.3);
      tone(a, { from: 150, to: 45, dur: 0.16, peak: 0.5 });
    },
    hit() {
      const a = audioCtx();
      if (!a) return;
      const nasal = { type: 'bandpass', freq: 1300, q: 2.5 };
      tone(a, { type: 'sawtooth', from: 640, to: 360, dur: 0.11, peak: 0.35, filter: nasal });
      tone(a, { type: 'sawtooth', from: 560, to: 300, at: 0.13, dur: 0.12, peak: 0.3, filter: nasal });
    },
    escape() {
      const a = audioCtx();
      if (a) tone(a, { type: 'triangle', from: 420, to: 1250, dur: 0.42, peak: 0.12 });
    },
    wave() {
      const a = audioCtx();
      if (!a) return;
      tone(a, { from: 660, dur: 0.09, peak: 0.16 });
      tone(a, { from: 990, at: 0.1, dur: 0.14, peak: 0.16 });
    },
    empty() {
      const a = audioCtx();
      if (a) tone(a, { type: 'square', from: 1400, to: 900, dur: 0.035, peak: 0.08 });
    },
    end(good) {
      const a = audioCtx();
      if (!a) return;
      const notes = good ? [523, 659, 784, 1047] : [440, 392, 330];
      notes.forEach((from, i) => tone(a, { type: 'triangle', from, at: i * 0.11, dur: 0.18, peak: 0.18 }));
    },
  };

  function setMuted(value) {
    muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? '1' : '0');
    } catch {
      // sin almacenamiento: solo dura esta visita
    }
    const btn = $('#dk-mute');
    btn.querySelector('i').className = `bi ${muted ? 'bi-volume-mute-fill' : 'bi-volume-up-fill'}`;
    btn.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
    btn.setAttribute('aria-pressed', String(muted));
  }

  // ---------- escenario (se pinta una vez por tamaño) ----------

  /** Aleatorio con semilla: el paisaje sale igual en cada redimensionado. */
  function prng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function circle(l, x, y, r) {
    l.beginPath();
    l.arc(x, y, r, 0, TAU);
    l.fill();
  }

  function cloud(l, x, y, w) {
    l.fillStyle = 'rgba(255, 214, 226, .2)';
    for (const [dx, dy, rx, ry] of [[0, 0, 0.5, 0.18], [-0.28, 0.04, 0.3, 0.13], [0.3, 0.05, 0.34, 0.12], [0.08, -0.1, 0.26, 0.14]]) {
      l.beginPath();
      l.ellipse(x + dx * w, y + dy * w, rx * w, ry * w, 0, 0, TAU);
      l.fill();
    }
  }

  function hills(l, base, amp, color, rnd) {
    const A = ASPECT;
    const n = 6;
    l.fillStyle = color;
    l.beginPath();
    l.moveTo(0, 1);
    l.lineTo(0, base);
    for (let i = 0; i < n; i++) {
      const x0 = (i / n) * A;
      const x1 = ((i + 1) / n) * A;
      l.quadraticCurveTo((x0 + x1) / 2, base - amp * (0.5 + rnd()), x1, base + amp * 0.2 * (rnd() - 0.5));
    }
    l.lineTo(A, 1);
    l.closePath();
    l.fill();
  }

  /** Cielo al atardecer, sol, nubes, colinas y lago. */
  function paintBack(l) {
    const A = ASPECT;
    const rnd = prng(7);
    const sky = l.createLinearGradient(0, 0, 0, 0.72);
    sky.addColorStop(0, '#1b2350');
    sky.addColorStop(0.42, '#4d3f86');
    sky.addColorStop(0.78, '#c4668a');
    sky.addColorStop(1, '#f5a86b');
    l.fillStyle = sky;
    l.fillRect(0, 0, A, 1);

    l.fillStyle = '#fff';
    for (let i = 0; i < 40; i++) {
      const y = rnd() * 0.32;
      l.globalAlpha = Math.max(0, 0.7 - y * 2);
      circle(l, rnd() * A, y, 0.0015 + rnd() * 0.002);
    }
    l.globalAlpha = 1;

    const sx = A * 0.72;
    const sy = 0.63;
    const glow = l.createRadialGradient(sx, sy, 0, sx, sy, 0.5);
    glow.addColorStop(0, 'rgba(255, 220, 160, .55)');
    glow.addColorStop(1, 'rgba(255, 200, 150, 0)');
    l.fillStyle = glow;
    l.fillRect(0, 0, A, 1);
    l.fillStyle = '#ffe3a8';
    circle(l, sx, sy, 0.085);

    cloud(l, 0.32, 0.2, 0.22);
    cloud(l, 1.05, 0.13, 0.3);
    cloud(l, 1.52, 0.31, 0.18);

    hills(l, 0.6, 0.06, '#3a2f63', rnd);
    hills(l, 0.665, 0.045, '#2a2c4f', rnd);

    const lake = l.createLinearGradient(0, 0.69, 0, 0.8);
    lake.addColorStop(0, '#7a5f9e');
    lake.addColorStop(1, '#2b3560');
    l.fillStyle = lake;
    l.fillRect(0, 0.69, A, 0.31);
    l.fillStyle = 'rgba(255, 222, 170, .38)';
    for (let i = 0; i < 12; i++) {
      const w = 0.16 - i * 0.011;
      l.fillRect(sx - w / 2 + (rnd() - 0.5) * 0.02, 0.695 + i * 0.006, w, 0.0022);
    }
  }

  function reeds(l, x, rnd) {
    for (let i = 0; i < 6; i++) {
      const bx = x + (rnd() - 0.5) * 0.08;
      const top = 0.56 + rnd() * 0.1;
      const lean = (rnd() - 0.5) * 0.04;
      l.strokeStyle = '#2c5a2e';
      l.lineWidth = 0.005;
      l.beginPath();
      l.moveTo(bx, 0.8);
      l.quadraticCurveTo(bx, (top + 0.8) / 2, bx + lean, top);
      l.stroke();
      if (rnd() < 0.7) {
        l.fillStyle = '#6b4226';
        l.beginPath();
        l.ellipse(bx + lean, top + 0.028, 0.008, 0.027, lean * 2, 0, TAU);
        l.fill();
        l.beginPath();
        l.moveTo(bx + lean, top);
        l.lineTo(bx + lean * 1.2, top - 0.02);
        l.stroke();
      }
      l.strokeStyle = '#3b7a3a';
      l.lineWidth = 0.004;
      l.beginPath();
      l.moveTo(bx, 0.8);
      l.quadraticCurveTo(bx + 0.03 * (rnd() < 0.5 ? -1 : 1), 0.7, bx + (rnd() - 0.5) * 0.08, 0.64 + rnd() * 0.05);
      l.stroke();
    }
  }

  function bush(l, x, y, r) {
    l.fillStyle = '#285f31';
    for (const [dx, dy, k] of [[-0.9, 0.2, 0.6], [-0.4, -0.2, 0.75], [0.2, -0.3, 0.8], [0.8, 0.1, 0.65], [0, 0.25, 0.8]]) circle(l, x + dx * r, y + dy * r, k * r);
    l.fillStyle = 'rgba(120, 190, 110, .25)';
    circle(l, x - 0.3 * r, y - 0.4 * r, 0.35 * r);
  }

  /** Juncos, pasto y arbustos: se dibujan por delante de los patos. */
  function paintFront(l) {
    const A = ASPECT;
    const rnd = prng(11);
    for (const x of [0.07, 0.45, 1.12, 1.66]) reeds(l, x, rnd);

    const grass = l.createLinearGradient(0, 0.74, 0, 1);
    grass.addColorStop(0, '#3f8a43');
    grass.addColorStop(1, '#173b22');
    l.fillStyle = grass;
    l.beginPath();
    l.moveTo(0, 1);
    l.lineTo(0, 0.765);
    for (let x = 0; x < A; x += 0.05) l.quadraticCurveTo(x + 0.025, 0.742 + rnd() * 0.02, x + 0.05, 0.762 + rnd() * 0.012);
    l.lineTo(A, 1);
    l.closePath();
    l.fill();

    l.lineWidth = 0.0035;
    for (let i = 0; i < 220; i++) {
      const x = rnd() * A;
      const y = 0.765 + rnd() * 0.23;
      l.strokeStyle = rnd() < 0.5 ? 'rgba(130, 200, 115, .5)' : 'rgba(18, 55, 28, .6)';
      l.beginPath();
      l.moveTo(x, y);
      l.lineTo(x + (rnd() - 0.5) * 0.012, y - 0.012 - rnd() * 0.028);
      l.stroke();
    }
    bush(l, 0.26, 0.8, 0.06);
    bush(l, 1.38, 0.79, 0.075);
  }

  function makeLayer(height, offsetY, paint) {
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = Math.max(1, Math.round(height));
    const l = layer.getContext('2d');
    l.setTransform(W / ASPECT, 0, 0, H, 0, -offsetY);
    paint(l);
    return layer;
  }

  function resize() {
    const frame = $('#dk-frame');
    const cssW = frame.clientWidth;
    const cssH = frame.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (w === W && h === H && layers) return;
    W = canvas.width = w;
    H = canvas.height = h;
    const frontY = Math.round(FRONT_TOP * H);
    layers = { back: makeLayer(H, 0, paintBack), front: makeLayer(H - frontY, frontY, paintFront), frontY };
    kick();
  }

  // ---------- dibujo ----------

  /** Un pato en (x, y) normalizados. `mode`: fly | hit | fall | flee. */
  function duckSprite(x, y, dir, angle, mode, pal, now) {
    const flap = mode === 'fly' ? Math.sin(now * 0.05) : mode === 'flee' ? Math.sin(now * 0.085) : 1;
    g.save();
    g.translate(x * ASPECT, y);
    if (angle) g.rotate(angle);
    g.scale(dir * DUCK_SCALE, DUCK_SCALE);

    // cola
    g.fillStyle = pal.wing;
    g.beginPath();
    g.moveTo(-34, -4);
    g.lineTo(-62, -18);
    g.quadraticCurveTo(-58, 2, -40, 10);
    g.closePath();
    g.fill();
    // cuerpo y barriga
    g.fillStyle = pal.body;
    g.beginPath();
    g.ellipse(-4, 0, 40, 25, -0.08, 0, TAU);
    g.fill();
    g.fillStyle = pal.belly;
    g.beginPath();
    g.ellipse(2, 10, 28, 12, -0.05, 0, TAU);
    g.fill();
    // cuello y cabeza
    g.fillStyle = pal.head;
    g.beginPath();
    g.ellipse(24, -10, 12, 16, 0.6, 0, TAU);
    g.fill();
    circle(g, 34, -22, 18);
    // pico
    g.fillStyle = '#ffb534';
    g.beginPath();
    g.moveTo(47, -27);
    g.quadraticCurveTo(68, -26, 70, -19);
    g.quadraticCurveTo(62, -13, 47, -15);
    g.closePath();
    g.fill();
    g.strokeStyle = '#d98a1c';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(49, -20);
    g.lineTo(64, -20);
    g.stroke();
    // ojo (en cruz al recibir el disparo) y mejilla
    if (mode === 'hit' || mode === 'fall') {
      g.strokeStyle = '#1b1b2a';
      g.lineWidth = 2.6;
      g.beginPath();
      g.moveTo(34, -31);
      g.lineTo(42, -23);
      g.moveTo(42, -31);
      g.lineTo(34, -23);
      g.stroke();
    } else {
      g.fillStyle = '#fff';
      circle(g, 38, -27, 6);
      g.fillStyle = '#1b1b2a';
      circle(g, 40, -27, 3.2);
      g.fillStyle = '#fff';
      circle(g, 41, -29, 1.1);
    }
    g.fillStyle = 'rgba(255, 140, 160, .45)';
    circle(g, 32, -15, 4.5);
    // ala, por delante del cuerpo
    g.save();
    g.translate(-6, -8);
    g.rotate(0.2 + 0.7 * flap);
    g.fillStyle = pal.wing;
    g.beginPath();
    g.ellipse(-16, -2, 28, 11, 0, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, .25)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-36, -2);
    g.lineTo(-10, -2);
    g.moveTo(-32, 4);
    g.lineTo(-12, 3);
    g.stroke();
    g.restore();

    g.restore();
  }

  function drawDucks(t, now) {
    for (const [id, d] of ducks) {
      if (d.state === 'hit') {
        const since = now - d.hitShown;
        const p0 = (d.hitPos ??= track.duckPosition(d.params, d.hitAt));
        if (since < FALL_PAUSE_MS) {
          duckSprite(p0.x, p0.y, p0.dir, 0, 'hit', d.pal, now);
          continue;
        }
        const s = (since - FALL_PAUSE_MS) / 1000;
        const y = p0.y + 0.15 * s + 1.6 * s * s;
        if (y > 1.15) ducks.delete(id);
        else duckSprite(p0.x, y, p0.dir, s * 7 * p0.dir, 'fall', d.pal, now);
        continue;
      }
      if (t < d.params.spawnAt) continue;
      if (t >= d.escapeAt) {
        // Escapa volando hacia arriba desde donde estaba.
        const p0 = track.duckPosition(d.params, d.escapeAt);
        const s = (t - d.escapeAt) / 1000;
        if (!d.fled) {
          d.fled = true;
          if (!p0.gone && s < 0.3) sfx.escape();
        }
        const y = p0.y - (0.5 * s + 1.1 * s * s);
        if (p0.gone || y < -0.25) {
          if (d.state === 'escaped' || !round) ducks.delete(id); // si no, espera a que lo confirme el servidor
          continue;
        }
        duckSprite(p0.x + p0.dir * 0.06 * s, y, p0.dir, -0.9 * p0.dir, 'flee', d.pal, now);
        continue;
      }
      const p = track.duckPosition(d.params, t);
      if (p.gone) continue;
      // Inclina el cuerpo hacia donde vuela.
      const q = track.duckPosition(d.params, t + 30);
      const dx = (q.x - p.x) * ASPECT;
      const dy = q.y - p.y;
      const tilt = (p.dir > 0 ? Math.atan2(dy, dx) : Math.atan2(-dy, -dx)) * 0.45;
      duckSprite(p.x, p.y, p.dir, tilt, 'fly', d.pal, now);
    }
  }

  function drawEffects(now) {
    effects = effects.filter((e) => now - e.start < e.life);
    for (const e of effects) {
      const p = (now - e.start) / e.life;
      const X = e.x * ASPECT;
      if (e.kind === 'shot') {
        g.strokeStyle = `rgba(255, 244, 214, ${1 - p})`;
        g.lineWidth = 0.006;
        g.beginPath();
        g.arc(X, e.y, 0.012 + 0.05 * p, 0, TAU);
        g.stroke();
        if (p < 0.35) {
          g.fillStyle = `rgba(255, 250, 230, ${0.8 - p * 2.2})`;
          circle(g, X, e.y, 0.018);
        }
      } else if (e.kind === 'mark') {
        // Impacto provisional: solo un destello; el pato no cae hasta que responde el servidor.
        g.strokeStyle = `rgba(255, 255, 255, ${1 - p})`;
        g.lineWidth = 0.005;
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          const r0 = 0.015 + 0.02 * p;
          g.moveTo(X + Math.cos(a) * r0, e.y + Math.sin(a) * r0);
          g.lineTo(X + Math.cos(a) * (r0 + 0.018), e.y + Math.sin(a) * (r0 + 0.018));
        }
        g.stroke();
      } else if (e.kind === 'feather') {
        const s = (now - e.start) / 1000;
        g.save();
        g.translate(X + e.vx * s, e.y + e.vy * s + 0.25 * s * s);
        g.rotate(e.spin * s);
        g.globalAlpha = 1 - p;
        g.fillStyle = e.color;
        g.beginPath();
        g.ellipse(0, 0, 0.011, 0.004, 0, 0, TAU);
        g.fill();
        g.restore();
      } else if (e.kind === 'text') {
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = Math.min(1, 2.5 - p * 2.5);
        g.font = `800 ${Math.round(H * 0.065)}px "Inter Variable", system-ui, sans-serif`;
        g.textAlign = 'center';
        g.lineWidth = Math.max(2, H * 0.008);
        g.strokeStyle = 'rgba(20, 12, 4, .7)';
        g.fillStyle = '#f7dc8f';
        const px = e.x * W;
        const py = (e.y - 0.08 - 0.08 * p) * H;
        g.strokeText(e.text, px, py);
        g.fillText(e.text, px, py);
        g.restore();
      }
    }
  }

  function drawCrosshair() {
    if (!pointer || !round || cardShown()) return;
    const X = pointer.x * ASPECT;
    const Y = pointer.y;
    const ring = (width, color) => {
      g.lineWidth = width;
      g.strokeStyle = color;
      g.beginPath();
      g.arc(X, Y, 0.032, 0, TAU);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.moveTo(X + dx * 0.02, Y + dy * 0.02);
        g.lineTo(X + dx * 0.048, Y + dy * 0.048);
      }
      g.stroke();
    };
    ring(0.009, 'rgba(10, 8, 20, .55)');
    ring(0.0045, '#fff4d6');
    g.fillStyle = '#ff6b5e';
    circle(g, X, Y, 0.0045);
  }

  function draw(now) {
    if (!layers || !track) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(layers.back, 0, 0);
    g.setTransform(W / ASPECT, 0, 0, H, 0, 0);
    drawDucks(roundT(now), now);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(layers.front, 0, layers.frontY);
    g.setTransform(W / ASPECT, 0, 0, H, 0, 0);
    drawEffects(now);
    drawCrosshair();
  }

  function frame(now) {
    raf = 0;
    if (!active || document.hidden) return;
    draw(now);
    // Sin ronda ni animaciones, la escena está quieta: se deja de redibujar.
    if (round || ducks.size || effects.length) raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!raf && active && !document.hidden) raf = requestAnimationFrame(frame);
  }

  // ---------- HUD, mensajes y pantalla de inicio/resultados ----------

  function banner(text, ms = 1400) {
    const el = $('#dk-banner');
    clearTimeout(bannerTimer);
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth; // reinicia la animación
    el.classList.add('show');
    if (ms) bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function renderHud() {
    const r = round;
    $('#dk-wave').textContent = !r ? 'Oleada –' : r.wave ? `Oleada ${r.wave}/${r.waves}` : '¡Prepárate!';

    const ammoPer = r?.ammoPerWave ?? 3;
    const ammo = $('#dk-ammo');
    if (ammo.children.length !== ammoPer) ammo.replaceChildren(...Array.from({ length: ammoPer }, () => span('dk-bullet')));
    [...ammo.children].forEach((el, i) => el.classList.toggle('spent', !r || !r.waveOpen || i >= r.ammo));
    ammo.setAttribute('aria-label', `Balas: ${r?.waveOpen ? r.ammo : 0} de ${ammoPer}`);

    const results = r?.results ?? lastResults;
    const total = results.length || status?.ducksPerRound || 10;
    const perWave = r ? Math.ceil(r.total / r.waves) : 2;
    const tally = $('#dk-tally');
    if (tally.children.length !== total) tally.replaceChildren(...Array.from({ length: total }, () => span('dk-slot')));
    [...tally.children].forEach((el, i) => {
      const state = results[i] ?? 'pending';
      el.className = `dk-slot ${state}`;
      if (r?.waveOpen && state === 'pending' && Math.floor(i / perWave) + 1 === r.wave) el.classList.add('current');
    });
    const hits = results.filter((s) => s === 'hit').length;
    tally.setAttribute('aria-label', `Patos derribados: ${hits} de ${total}`);

    $('#dk-earned').textContent = `+${fmt(r ? earned() : result?.reward ?? 0)}`;
    $('#dk-quit').classList.toggle('hidden', !r);
    $('#dk-frame').classList.toggle('aiming', r !== null);
  }

  const secondsLeft = (end) => Math.max(0, Math.ceil((end - performance.now()) / 1000));

  /** Cambia el texto solo si es distinto: las regiones aria-live lo leerían otra vez. */
  function setText(sel, text) {
    const el = $(sel);
    if (el.textContent !== text) el.textContent = text;
  }

  /** hh:mm hasta que se libere cupo. */
  function hhmm(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function renderCard() {
    const card = $('#dk-card');
    card.classList.toggle('hidden', round !== null);
    clearInterval(countdown);
    if (round) return;

    const play = $('#dk-play');
    const label = $('#dk-play-label');
    if (result) {
      $('#dk-card-title').textContent = result.ducksHit >= GREAT_ROUND ? '¡Puntería de campeón!' : 'Ronda terminada';
      const capped = result.reward < result.ducksHit * (status?.reward ?? 0);
      let text = `Derribaste ${result.ducksHit} de ${result.ducksTotal} patos · +${fmt(result.reward)} créditos`;
      if (result.error) text = `Derribaste ${result.ducksHit} de ${result.ducksTotal} patos, pero no se pudieron sumar los créditos.`;
      else if (capped) text += ' (tope diario)';
      setText('#dk-card-text', text);
    } else {
      $('#dk-card-title').textContent = 'Patos';
      setText(
        '#dk-card-text',
        status?.enabled ? `Gratis · ${fmt(status.reward)} créditos por pato · ${status.ducksPerRound} patos por ronda` : 'Cargando…'
      );
    }

    if (!status?.enabled) {
      play.disabled = true;
      setText('#dk-quota', '');
      return;
    }
    const again = result ? 'Otra ronda' : 'Jugar';
    const update = () => {
      const reset = secondsLeft(resetEnd);
      const cooldown = secondsLeft(cooldownEnd);
      if (status.dailyRemaining === 0) {
        setText('#dk-quota', 'Ya ganaste el máximo de créditos de hoy con los patos.');
        label.textContent = reset > 0 ? `Vuelve en ${hhmm(reset)}` : 'Vuelve mañana';
        play.disabled = true;
        if (reset === 0 && resetEnd) {
          resetEnd = 0;
          refreshStatus();
        }
        return;
      }
      setText('#dk-quota', `Hoy puedes ganar ${fmt(status.dailyRemaining)} créditos más.`);
      label.textContent = cooldown > 0 ? `${again} (${cooldown} s)` : again;
      play.disabled = starting || cooldown > 0;
    };
    update();
    if (secondsLeft(cooldownEnd) > 0 || status.dailyRemaining === 0) countdown = setInterval(update, 1000);
  }

  function applyLimits({ cooldownSeconds, resetSeconds }) {
    const now = performance.now();
    cooldownEnd = now + (cooldownSeconds ?? 0) * 1000;
    resetEnd = resetSeconds ? now + resetSeconds * 1000 : 0;
  }

  async function refreshStatus() {
    try {
      status = await ctx.api('/api/ducks/status');
    } catch {
      return; // se deja como estaba
    }
    $('.tabs [data-tab="ducks"]').classList.toggle('hidden', !status.enabled);
    if (!status.enabled) return;
    applyLimits(status);
    const limit = status.dailyLimit ? ` · Máximo ${fmt(status.dailyLimit)} créditos al día` : '';
    $('#dk-rules').textContent =
      `Gratis · ${status.ducksPerRound} patos por ronda, de 2 en 2 · 3 disparos por oleada · ` +
      `${fmt(status.reward)} créditos por pato${limit} · Los créditos se suman al terminar la ronda`;
    if (status.active && !round) resume();
    renderCard();
    renderHud();
  }

  // ---------- ronda ----------

  /** Ajusta el reloj de la ronda con el `now` (ms de ronda) que manda el servidor. */
  function sync(now) {
    if (typeof now !== 'number') return;
    // Cuanto antes llega un mensaje, mejor la estimación: se queda la mínima.
    clockStart = Math.min(clockStart, performance.now() - now);
  }

  function addDuck(duckId, params) {
    if (ducks.has(duckId)) return;
    ducks.set(duckId, {
      params,
      escapeAt: track.duckEscapeAt(params),
      state: 'flying',
      pal: PALETTES[(duckId + round.id) % PALETTES.length],
      hitAt: null,
      hitShown: 0,
      fled: false,
    });
    kick();
  }

  function resume() {
    if (performance.now() - resumedAt < RESUME_THROTTLE_MS) return;
    resumedAt = performance.now();
    ctx.emit('ducks:resume');
  }

  /** Evento de otra ronda (p. ej. empezada en otra pestaña): se pide el estado actual. */
  function foreign(roundId) {
    if (mine(roundId)) return false;
    if (active) resume();
    return true;
  }

  function onRound(snap) {
    if (!track) return void trackReady.then(() => onRound(snap));
    if (!snap) {
      // No hay ronda: si creíamos tener una, terminó mientras estábamos desconectados.
      if (round) {
        round = null;
        result = null;
        ducks.clear();
        refreshStatus();
        renderHud();
        renderCard();
      }
      firstRound = false;
      return;
    }
    if (!mine(snap.roundId)) {
      ducks.clear();
      effects = [];
      pending.clear();
      lastShotT = 0;
      clockStart = performance.now() - snap.now;
    } else {
      sync(snap.now);
    }
    round = {
      id: snap.roundId,
      total: snap.ducksTotal,
      waves: snap.waves,
      wave: snap.wave,
      waveOpen: snap.waveOpen,
      ammo: snap.ammo,
      ammoPerWave: snap.ammoPerWave,
      reward: snap.reward,
      maxReward: snap.maxReward,
      hits: snap.ducksHit,
      results: snap.results.slice(),
    };
    for (const { duckId, params } of snap.flying) addDuck(duckId, params);
    result = null;
    $('.tabs [data-tab="ducks"]').classList.remove('hidden');
    renderHud();
    renderCard();
    if (!snap.wave) banner('¡Prepárate!');
    // Al recargar la página con una ronda en juego, se vuelve a ella.
    if (firstRound && !active) $('.tabs [data-tab="ducks"]').click();
    firstRound = false;
    kick();
  }

  function onWave({ roundId, wave, ammo, now }) {
    if (foreign(roundId)) return;
    sync(now);
    Object.assign(round, { wave, ammo, waveOpen: true });
    pending.clear();
    renderHud();
    banner(`Oleada ${wave}`, 1100);
    if (active) sfx.wave();
  }

  function onSpawn({ roundId, duckId, params, now }) {
    if (foreign(roundId) || !track) return;
    sync(now);
    addDuck(duckId, params);
  }

  function waveResolved() {
    const perWave = Math.ceil(round.total / round.waves);
    const from = (round.wave - 1) * perWave;
    return round.results.slice(from, from + perWave).every((s) => s !== 'pending');
  }

  function onShotResult({ roundId, t, hit, duckId, ammoLeft, ignored }) {
    if (foreign(roundId)) return;
    pending.delete(t);
    round.ammo = Math.max(0, ammoLeft - pending.size);
    effects = effects.filter((e) => !(e.kind === 'mark' && e.t === t));
    if (ignored === 'late') banner('Conexión lenta: ese disparo no contó', 1600);
    if (hit) {
      const before = earned();
      round.hits++;
      const gain = earned() - before; // 0 si ya se llegó al tope diario
      round.results[duckId] = 'hit';
      const duck = ducks.get(duckId);
      if (duck) {
        duck.state = 'hit';
        duck.hitAt = t;
        duck.hitShown = performance.now();
        const p = track.duckPosition(duck.params, t);
        const now = performance.now();
        if (!ctx.reducedMotion.matches) {
          for (let i = 0; i < 7; i++) {
            effects.push({
              kind: 'feather', x: p.x, y: p.y, start: now, life: 1100,
              vx: (Math.random() - 0.5) * 0.5, vy: -0.1 - Math.random() * 0.25, spin: (Math.random() - 0.5) * 12,
              color: i % 2 ? duck.pal.body : duck.pal.belly,
            });
          }
        }
        if (gain > 0) effects.push({ kind: 'text', text: `+${fmt(gain)}`, x: p.x, y: p.y, start: now, life: 1000 });
        if (active) sfx.hit();
      }
    }
    if (round.ammo === 0 || waveResolved()) round.waveOpen = false;
    renderHud();
    kick();
  }

  function onEscaped({ roundId, duckId, at }) {
    if (foreign(roundId)) return;
    round.results[duckId] = 'escaped';
    const duck = ducks.get(duckId);
    if (duck && duck.state !== 'hit') {
      duck.state = 'escaped';
      duck.escapeAt = Math.min(duck.escapeAt, at);
    }
    if (waveResolved()) round.waveOpen = false;
    renderHud();
    kick();
  }

  function onEnd(data) {
    if (round && round.id !== data.roundId) return;
    const t = roundT();
    // Los que seguían volando (p. ej. al terminar antes de tiempo) se van.
    for (const duck of ducks.values()) if (duck.state === 'flying') duck.escapeAt = Math.min(duck.escapeAt, t);
    lastResults = round?.results ?? lastResults;
    round = null;
    result = data;
    pending.clear();
    if (status) {
      if (data.dailyRemaining !== null) status.dailyRemaining = data.dailyRemaining;
      applyLimits(data);
    }
    renderHud();
    renderCard();
    $('#dk-banner').classList.remove('show');
    if (data.error) ctx.toast('No se pudieron sumar los créditos de la ronda.', 'error');
    else if (data.reward > 0) ctx.toast(`+${fmt(data.reward)} créditos por los patos`, 'success');
    if (active) {
      sfx.end(data.ducksHit >= GREAT_ROUND);
      if (data.ducksHit >= GREAT_ROUND) ctx.confetti();
    }
    kick();
  }

  // ---------- controles ----------

  async function play() {
    if (starting) return;
    starting = true;
    audioCtx(); // el navegador solo deja arrancar el audio tras un gesto del jugador
    renderCard();
    const res = await ctx.emit('ducks:start');
    starting = false;
    if (!res.ok) {
      ctx.toast(res.error, 'error');
      if (res.retryAfter) {
        if (res.dailyLimit && status) {
          status.dailyRemaining = 0;
          resetEnd = performance.now() + res.retryAfter * 1000;
        } else cooldownEnd = performance.now() + res.retryAfter * 1000;
      }
    }
    renderCard();
  }

  function toCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    audioCtx();
    if (!round || !track || cardShown()) return;
    const { x, y } = toCanvas(e);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    if (!round.waveOpen || round.ammo <= 0) {
      sfx.empty();
      return;
    }
    const t = Math.max(roundT(), lastShotT + 0.001);
    lastShotT = t;
    round.ammo--;
    pending.add(t);
    const now = performance.now();
    effects.push({ kind: 'shot', x, y, start: now, life: 260 });
    sfx.shot();

    // Si parece que acertó, un destello; el pato cae solo si el servidor lo confirma.
    for (const duck of ducks.values()) {
      if (duck.state !== 'flying' || t < duck.params.spawnAt || t >= duck.escapeAt) continue;
      const p = track.duckPosition(duck.params, t);
      if (!p.gone && track.distance(p.x, p.y, x, y) < duck.params.radius) {
        effects.push({ kind: 'mark', t, x: p.x, y: p.y, start: now, life: 450 });
        break;
      }
    }
    renderHud();
    kick();

    const roundId = round.id;
    ctx.emit('ducks:shot', { roundId, x, y, t }).then((res) => {
      if (res.ok) return;
      pending.delete(t);
      if (mine(roundId) && res.error === 'Esa ronda ya terminó') resume();
      else if (res.error !== 'Vas demasiado rápido') banner(res.error, 1600);
    });
  }

  function onPointerMove(e) {
    if (e.pointerType !== 'mouse') return;
    pointer = toCanvas(e);
    kick();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    $('#dk-stage')
      .requestFullscreen()
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {}); // sin permiso o sin bloqueo de orientación: se juega igual
  }

  function onVisibility() {
    if (document.hidden) {
      // No hay pausa real: la ronda sigue en el servidor (así no se puede manipular el tiempo).
      if (round) banner('Pausado', 0);
      return;
    }
    if (round) banner('Pausado', 900);
    kick();
  }

  function setActive(value) {
    active = value;
    if (!active) return;
    resize();
    if (!round) refreshStatus();
    kick();
  }

  function init(appCtx) {
    ctx = appCtx;
    canvas = $('#dk-canvas');
    g = canvas.getContext('2d');
    try {
      muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      muted = false;
    }
    setMuted(muted);

    trackReady
      .then((mod) => {
        track = mod;
        ASPECT = mod.ASPECT;
        layers = null;
        resize();
      })
      .catch((err) => console.error('[patos] No se pudo cargar duck-path.js', err));

    new ResizeObserver(() => active && resize()).observe($('#dk-frame'));
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', () => {
      pointer = null;
      kick();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    $('#dk-play').addEventListener('click', play);
    $('#dk-quit').addEventListener('click', () => {
      if (round) ctx.emit('ducks:quit', { roundId: round.id });
    });
    $('#dk-mute').addEventListener('click', () => setMuted(!muted));
    const full = $('#dk-full');
    full.classList.toggle('hidden', !document.fullscreenEnabled);
    full.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement === $('#dk-stage');
      full.querySelector('i').className = `bi ${on ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen'}`;
      full.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
    });
    document.addEventListener('visibilitychange', onVisibility);

    ctx.socket.on('ducks:round', onRound);
    ctx.socket.on('ducks:wave', onWave);
    ctx.socket.on('ducks:spawn', onSpawn);
    ctx.socket.on('ducks:shotResult', onShotResult);
    ctx.socket.on('ducks:escaped', onEscaped);
    ctx.socket.on('ducks:end', onEnd);
    // Al conectar (y al reconectar) se recupera la ronda en juego, si la hay.
    ctx.socket.on('connect', () => {
      resumedAt = 0;
      resume();
    });

    renderHud();
    renderCard();
    refreshStatus();
  }

  return { init, setActive };
})();
