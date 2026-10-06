'use strict';

// Bordes de perfil (cosméticos de la tienda): un aro de metal alrededor de la foto y alas de
// plumas metálicas a los lados, dibujados en SVG. El catálogo y los precios están en el servidor
// (src/cosmetics.js); aquí, cómo se ve cada id.
//
// Cada borde son capas separadas (alas, aro, brillo, órbita, aura) para que las animaciones solo
// muevan `transform`/`opacity` de elementos enteros y el navegador no tenga que repintar el SVG
// en cada fotograma (ver las reglas de rendimiento en CLAUDE.md). Sus medidas van en % del tamaño
// de la foto: 1 unidad del SVG = 1 % del avatar, así el mismo borde sirve en cualquier tamaño.
window.FramesUI = (() => {
  // Paradas del degradado metálico, de un filo de la pluma al otro (claro, sombra, brillo, oscuro, medio).
  const METALS = {
    iron: ['#eef1f4', '#9199a3', '#d6dbe0', '#4f565f', '#b3bac2'],
    bronze: ['#ffe2bd', '#b06d34', '#eab37f', '#6e3c14', '#cd8c52'],
    silver: ['#ffffff', '#b4bdc8', '#f4f7fa', '#76808d', '#dde3ea'],
    steel: ['#e8f3ff', '#5a82b0', '#bcd6f3', '#26446b', '#8db0d8'],
    jade: ['#e8fff4', '#3b9a70', '#ade9cb', '#1a563c', '#6cc79d'],
    copper: ['#ffe3d0', '#c05b27', '#f4a477', '#74290c', '#e07743'],
    gold: ['#fff7d6', '#c69029', '#ffe28f', '#7a500d', '#e7bb4f'],
    royal: ['#f6f9ff', '#8aa1c8', '#e1eaf8', '#465b84', '#b2c4e3'],
    arcane: ['#f7edff', '#8a5ec7', '#ddc6fc', '#46267a', '#ae87e5'],
    phoenix: ['#fff4c8', '#e06d18', '#ffd56e', '#96260a', '#ffa83a'],
    obsidian: ['#b9a3e6', '#2a2238', '#6d5a96', '#0b0812', '#45395c'],
    seraph: ['#ffffff', '#e6d7aa', '#fffbf0', '#b3944b', '#f2e5c2'],
    crimson: ['#ffb4a8', '#8f1414', '#ff5a4a', '#3d0404', '#c42a22'],
    ice: ['#ffffff', '#bfe9ff', '#ecf9ff', '#5aa7e0', '#a8dcff'],
    nebula: ['#e8d8ff', '#4b2b8f', '#b08cff', '#150a3b', '#6b4fd1'],
    ivory: ['#fffbe8', '#d6c59a', '#fff3cf', '#8a774e', '#e8dcbc'],
  };

  // tier: básico / especial / legendario / mítico (más plumas, alas más grandes y más efectos).
  const FRAMES = {
    hierro: { tier: 'basico', metal: 'iron', edge: '#2c3137', feathers: 4, len: 74, width: 13 },
    bronce: { tier: 'basico', metal: 'bronze', edge: '#46270d', feathers: 4, len: 74, width: 13 },
    plata: { tier: 'basico', metal: 'silver', edge: '#48515b', feathers: 4, len: 78, width: 13 },
    acero: { tier: 'especial', metal: 'steel', edge: '#14243a', feathers: 6, len: 92, width: 14, rivets: true },
    jade: { tier: 'especial', metal: 'jade', edge: '#0e3124', feathers: 6, len: 92, width: 14, rivets: true },
    cobre: { tier: 'especial', metal: 'copper', edge: '#461805', feathers: 6, len: 92, width: 14, rivets: true },
    oro: { tier: 'legendario', metal: 'gold', edge: '#573806', feathers: 8, len: 108, width: 15, rivets: true, gem: '#e3124f', aura: 'rgba(255, 196, 80, .55)' },
    zafiro: { tier: 'legendario', metal: 'royal', edge: '#1b2843', feathers: 8, len: 108, width: 15, rivets: true, gem: '#2a66ff', aura: 'rgba(80, 140, 255, .5)' },
    amatista: { tier: 'legendario', metal: 'arcane', edge: '#281145', feathers: 8, len: 108, width: 15, rivets: true, gem: '#a548ff', aura: 'rgba(170, 90, 255, .5)' },
    fenix: {
      tier: 'mitico', metal: 'phoenix', edge: '#571303', feathers: 10, len: 122, width: 15, rivets: true, gem: '#ff3a1c',
      crest: 'crown', low: true, aura: 'rgba(255, 110, 30, .62)', orbit: ['#ffe08a', '#ff8a1f', '#ff3a1c'],
    },
    obsidiana: {
      tier: 'mitico', metal: 'obsidian', edge: '#a77bff', feathers: 10, len: 122, width: 14, sharp: true, rivets: true, gem: '#b066ff',
      crest: 'horns', low: true, aura: 'rgba(140, 60, 255, .58)', orbit: ['#e2c6ff', '#9c5cff', '#6d28d9'],
    },
    serafin: {
      tier: 'mitico', metal: 'seraph', edge: '#977631', feathers: 10, len: 122, width: 15, rivets: true, gem: '#fff1a8',
      crest: 'halo', low: true, aura: 'rgba(255, 240, 190, .62)', orbit: ['#ffffff', '#ffe7a0', '#fff6d6'],
    },

    // Otros tipos de marco (cada `kind` tiene su función en BUILDERS, abajo).
    hexagono: { tier: 'basico', kind: 'hexagono', metal: 'silver', edge: '#3c4550' },
    laurel: { tier: 'basico', kind: 'laurel', metal: 'bronze', edge: '#46270d', ribbon: '#9b1d2a' },
    engranaje: { tier: 'basico', kind: 'engranaje', metal: 'copper', edge: '#461805', ring: 'iron' },
    escudo: { tier: 'especial', kind: 'escudo', metal: 'steel', edge: '#14243a', ring: 'gold', gem: '#e3124f' },
    loto: { tier: 'especial', kind: 'loto', metal: 'jade', edge: '#0e3124' },
    neon: { tier: 'especial', kind: 'neon', metal: 'arcane', edge: '#281145', pink: '#ff4fd8', cyan: '#45f3ff' },
    tormenta: { tier: 'legendario', kind: 'tormenta', metal: 'steel', edge: '#0c1a2e', glow: '#8ff3ff', bolt: '#3aa0ff', aura: 'rgba(70, 170, 255, .5)' },
    llamas: {
      tier: 'legendario', kind: 'llamas', metal: 'phoenix', edge: '#2a0d05', aura: 'rgba(255, 100, 20, .55)', orbit: ['#ffd34d', '#ff7a1a', '#ff3a1c'],
    },
    hielo: { tier: 'legendario', kind: 'hielo', metal: 'ice', edge: '#3f7fb4', aura: 'rgba(150, 220, 255, .55)' },
    dragon: {
      tier: 'mitico', kind: 'dragon', metal: 'crimson', edge: '#2a0505', bone: '#1c0b0b', claw: '#f5e6c4', gem: '#ffcf4d',
      aura: 'rgba(255, 40, 40, .5)', orbit: ['#ffcf4d', '#ff5a1f', '#ff2a2a'],
    },
    galaxia: { tier: 'mitico', kind: 'galaxia', metal: 'nebula', edge: '#0d0626', aura: 'rgba(150, 90, 255, .55)' },
    sol: { tier: 'mitico', kind: 'sol', metal: 'gold', edge: '#6b4306', aura: 'rgba(255, 200, 60, .6)', orbit: ['#fff3b0', '#ffc93d', '#ff9a1a'] },
  };

  // Centro de la foto: (50, 50). Hombros de las alas, en % de la foto.
  const SHOULDER = { x: 28, y: -6 }; // respecto al centro (ala derecha; la izquierda es su espejo)
  const LOW_SHOULDER = { x: 24, y: 12 };
  // Caja del aro (y de brillo y órbita): x de -70 a 70, y de -85 a 70.
  const RING_BOX = { x: -70, y: -85, w: 140, h: 155 };

  let uid = 0;
  const f1 = (n) => Math.round(n * 10) / 10;

  function gradient(id, stops, { x2 = 0, y2 = 1, reverse = false } = {}) {
    const list = reverse ? [...stops].reverse() : stops;
    const parts = list.map((c, i) => `<stop offset="${f1((i / (list.length - 1)) * 100)}%" stop-color="${c}"/>`).join('');
    return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${parts}</linearGradient>`;
  }

  /** Forma de una pluma a lo largo del eje x (base en 0, punta en L), de medio ancho w. */
  function featherPath(L, w, sharp) {
    if (sharp) return `M0 ${f1(-w * 0.5)}L${f1(L * 0.62)} ${f1(-w)}L${f1(L)} 0L${f1(L * 0.6)} ${f1(w * 0.42)}L0 ${f1(w * 0.5)}Z`;
    return `M0 ${f1(-w * 0.6)}C${f1(L * 0.35)} ${f1(-w * 1.25)} ${f1(L * 0.8)} ${f1(-w * 0.9)} ${f1(L)} 0C${f1(L * 0.78)} ${f1(w * 0.55)} ${f1(L * 0.35)} ${f1(w * 0.9)} 0 ${f1(w * 0.6)}Z`;
  }

  /**
   * Un ala (derecha; la izquierda se dibuja con x negativa). Devuelve el contenido SVG y su caja
   * en coordenadas con el hombro en (0, 0). `low`: el par de alas pequeño de abajo (míticos).
   */
  function wingShape(spec, p, low) {
    const n = low ? Math.max(3, spec.feathers - 4) : spec.feathers;
    const len = low ? spec.len * 0.52 : spec.len;
    const [angTop, angBottom] = low ? [18, 62] : [-48, 22]; // grados; 0 = hacia fuera, negativo = arriba
    const arm = low ? { x: len * 0.22, y: len * 0.1 } : { x: len * 0.42, y: -len * 0.3 };
    const box = { minX: -6, maxX: 6, minY: -8, maxY: 14 };
    const grow = (x, y, pad) => {
      box.minX = Math.min(box.minX, x - pad);
      box.maxX = Math.max(box.maxX, x + pad);
      box.minY = Math.min(box.minY, y - pad);
      box.maxY = Math.max(box.maxY, y + pad);
    };
    const feather = (bx, by, ang, L, w, fill) => {
      const rad = (ang * Math.PI) / 180;
      grow(bx + Math.cos(rad) * L, by + Math.sin(rad) * L, w);
      return (
        `<g transform="translate(${f1(bx)} ${f1(by)}) rotate(${f1(ang)})">` +
        `<path d="${featherPath(L, w, spec.sharp)}" fill="url(#${fill})" stroke="${spec.edge}" stroke-width="1.1" stroke-linejoin="round"/>` +
        `<path d="M3 0L${f1(L * 0.84)} 0" stroke="rgba(255,255,255,.55)" stroke-width=".8" stroke-linecap="round"/></g>`
      );
    };

    let svg = '';
    // Plumas largas, de la interior a la de la punta (la de la punta queda encima).
    for (let k = n - 1; k >= 0; k--) {
      const t = n === 1 ? 0 : k / (n - 1); // 0 = punta del ala, 1 = junto al cuerpo
      svg += feather(arm.x * (1 - t), arm.y * (1 - t), angTop + (angBottom - angTop) * t, len * (1 - 0.5 * t), spec.width * (1 - 0.2 * t), `${p}m`);
    }
    // Legendarios y míticos: una segunda capa de plumas cortas (cobertoras) con el brillo invertido.
    if (!low && (spec.tier === 'legendario' || spec.tier === 'mitico')) {
      const c = Math.ceil(n / 2);
      for (let k = c - 1; k >= 0; k--) {
        const t = c === 1 ? 0 : k / (c - 1);
        svg += feather(arm.x * (0.85 - 0.75 * t), arm.y * (0.85 - 0.75 * t), angTop + 18 + (angBottom - angTop - 10) * t, len * 0.42 * (1 - 0.3 * t), spec.width * 1.05, `${p}n`);
      }
    }
    // Placa del brazo que cubre la base de las plumas.
    const ax = f1(arm.x);
    const ay = f1(arm.y);
    svg +=
      `<path d="M-6 7Q${f1(arm.x * 0.35)} ${f1(arm.y * 0.15 - 9)} ${ax} ${ay}Q${f1(arm.x * 0.62)} ${f1(arm.y * 0.4 + 9)} -3 15Z" ` +
      `fill="url(#${p}n)" stroke="${spec.edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
    grow(arm.x, arm.y, 8);
    if (spec.gem && !low) {
      svg += `<circle cx="${ax}" cy="${ay}" r="4.6" fill="${spec.gem}" stroke="${spec.edge}" stroke-width="1"/><circle cx="${f1(arm.x - 1.4)}" cy="${f1(arm.y - 1.5)}" r="1.4" fill="#fff" opacity=".85"/>`;
    }
    return { svg, box };
  }

  /** Ala de murciélago (dragón): huesos y membrana en vez de plumas. Mismo sistema que wingShape. */
  function batWingShape(spec, p) {
    const W = '34 -34';
    const svg =
      `<path d="M0 -6L${W}L104 -76Q86 -42 124 -30Q98 -8 106 12Q70 4 24 26Q12 14 0 8Z" fill="url(#${p}m)" stroke="${spec.edge}" stroke-width="1.3" stroke-linejoin="round"/>` +
      `<path d="M${W}L104 -76M${W}L124 -30M${W}L106 12" fill="none" stroke="${spec.bone}" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M-4 2L${W}" stroke="${spec.bone}" stroke-width="5.5" stroke-linecap="round"/>` +
      `<path d="M34 -34l-4 -10 8 6z" fill="${spec.claw}"/><path d="M104 -76l2 -8 3 7z" fill="${spec.claw}"/>` +
      `<path d="M124 -30l7 -2 -5 6z" fill="${spec.claw}"/><path d="M106 12l5 5 -7 -1z" fill="${spec.claw}"/>`;
    return { svg, box: { minX: -9, maxX: 133, minY: -86, maxY: 30 } };
  }

  function wingEl(spec, side, low, shape = wingShape) {
    const p = `pf${++uid}`;
    const metal = METALS[spec.metal];
    const { svg, box } = shape(spec, p, low);
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const right = side === 'r';
    const shoulder = low ? LOW_SHOULDER : SHOULDER;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', `pf-art pf-wing ${side}${low ? ' low' : ''}`);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('viewBox', `${f1(right ? box.minX : -box.maxX)} ${f1(box.minY)} ${f1(w)} ${f1(h)}`);
    el.innerHTML =
      `<defs>${gradient(`${p}m`, metal)}${gradient(`${p}n`, metal, { reverse: true, x2: 1, y2: 1 })}</defs>` +
      (right ? svg : `<g transform="scale(-1 1)">${svg}</g>`);
    // Posición en % de la foto (escalada por --pf-k), con el hombro como centro de giro.
    const sx = 50 + (right ? shoulder.x : -shoulder.x);
    const left = right ? box.minX : -box.maxX;
    el.style.cssText =
      `left:calc(${sx}% + ${f1(left)}% * var(--pf-k));top:calc(${50 + shoulder.y}% + ${f1(box.minY)}% * var(--pf-k));` +
      `width:calc(${f1(w)}% * var(--pf-k));height:calc(${f1(h)}% * var(--pf-k));` +
      `transform-origin:${f1((-left / w) * 100)}% ${f1((-box.minY / h) * 100)}%`;
    return el;
  }

  function boxEl(cls, inner) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', `pf-art pf-box ${cls}`);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('viewBox', `${RING_BOX.x} ${RING_BOX.y} ${RING_BOX.w} ${RING_BOX.h}`);
    el.innerHTML = inner;
    return el;
  }

  function crestSvg(spec, p) {
    if (spec.crest === 'crown') {
      return (
        `<path d="M-19 -55L-22 -73L-11 -63L0 -82L11 -63L22 -73L19 -55Z" fill="url(#${p}r)" stroke="${spec.edge}" stroke-width="1.3" stroke-linejoin="round"/>` +
        `<circle cx="0" cy="-64" r="4" fill="${spec.gem}" stroke="${spec.edge}"/><circle cx="-22" cy="-74" r="2.2" fill="${spec.gem}"/><circle cx="22" cy="-74" r="2.2" fill="${spec.gem}"/><circle cx="0" cy="-83" r="2.4" fill="${spec.gem}"/>`
      );
    }
    if (spec.crest === 'horns') {
      const horn = `<path d="M-15 -51Q-31 -60 -36 -81Q-25 -67 -6 -56Z" fill="url(#${p}r)" stroke="${spec.edge}" stroke-width="1.2" stroke-linejoin="round"/>`;
      return `${horn}<g transform="scale(-1 1)">${horn}</g><path d="M0 -66L6 -56L0 -47L-6 -56Z" fill="${spec.gem}" stroke="${spec.edge}"/>`;
    }
    if (spec.crest === 'halo') {
      return (
        `<ellipse cx="0" cy="-73" rx="27" ry="6.5" fill="none" stroke="${spec.gem}" stroke-width="6" opacity=".35"/>` +
        `<ellipse cx="0" cy="-73" rx="27" ry="6.5" fill="none" stroke="url(#${p}r)" stroke-width="3"/>`
      );
    }
    // Legendarios: una gema tallada arriba del aro.
    return (
      `<path d="M0 -66L8 -55L0 -44L-8 -55Z" fill="${spec.gem}" stroke="${spec.edge}" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="M0 -66L3 -55L0 -44M-8 -55L8 -55" stroke="rgba(255,255,255,.45)" stroke-width=".8" fill="none"/>` +
      `<path d="M-2 -61L-5 -56" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".85"/>`
    );
  }

  function ringEl(spec) {
    const p = `pf${++uid}`;
    const metal = METALS[spec.metal];
    let svg =
      `<defs>${gradient(`${p}r`, metal, { x2: 1, y2: 1 })}</defs>` +
      `<circle r="53" fill="none" stroke="url(#${p}r)" stroke-width="6.5"/>` +
      `<circle r="56.4" fill="none" stroke="${spec.edge}" stroke-width="1.2"/>` +
      `<circle r="49.7" fill="none" stroke="${spec.edge}" stroke-width="1"/>`;
    if (spec.rivets) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
        svg += `<circle cx="${f1(Math.cos(a) * 53)}" cy="${f1(Math.sin(a) * 53)}" r="1.5" fill="${metal[0]}" stroke="${spec.edge}" stroke-width=".5"/>`;
      }
    }
    if (spec.gem) {
      for (const a of [-140, -40]) {
        const r = (a * Math.PI) / 180;
        svg += `<circle cx="${f1(Math.cos(r) * 53)}" cy="${f1(Math.sin(r) * 53)}" r="3.2" fill="${spec.gem}" stroke="${spec.edge}" stroke-width=".8"/>`;
      }
      svg += crestSvg(spec, p);
    }
    return boxEl('pf-ring', svg);
  }

  function shineEl() {
    // Un arco de brillo que da vueltas sobre el aro (gira el elemento entero).
    return boxEl(
      'pf-shine',
      '<circle r="53" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="3" stroke-linecap="round" stroke-dasharray="38 295"/>' +
        '<circle r="53" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="6" stroke-linecap="round" stroke-dasharray="18 315" stroke-dashoffset="-10"/>'
    );
  }

  function orbitEl(spec) {
    let svg = '';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = 61 + (i % 3) * 2;
      svg += `<circle cx="${f1(Math.cos(a) * r)}" cy="${f1(Math.sin(a) * r)}" r="${f1(1.4 + (i % 3) * 0.7)}" fill="${spec.orbit[i % spec.orbit.length]}" opacity="${f1(0.55 + (i % 3) * 0.2)}"/>`;
    }
    return boxEl('pf-orbit', svg);
  }

  // ---------- otros tipos de marco ----------
  // Cada capa es un <svg> con su caja en coordenadas del avatar (centro 0,0; radio 50; 1 unidad =
  // 1 % del avatar). Las que se animan lo hacen enteras (clases pfa-* de style.css), sin repintar.

  const NS = 'http://www.w3.org/2000/svg';
  const BIG = { x: -112, y: -112, w: 224, h: 224 };
  const nextId = () => `pf${++uid}`;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const polar = (r, deg) => [Math.cos(toRad(deg)) * r, Math.sin(toRad(deg)) * r];
  const pt = ([x, y]) => `${f1(x)} ${f1(y)}`;
  const pts = (list) => list.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');
  const range = (n) => Array.from({ length: n }, (_, i) => i);

  /**
   * Una capa. `z`: por debajo de la foto (0-1) o encima (3+). `scaled`: crece con --pf-k (solo
   * las alas, que se salen mucho). `anim`: clase pfa-<anim>, con `vars` (--d duración, --dl
   * retraso, --a ángulo, --s0/--s1 escala). Gira y escala alrededor de `origin` (por defecto, el
   * centro de la foto).
   */
  function layer(inner, { box = RING_BOX, z = 3, scaled = false, anim = null, vars = null, origin = [0, 0] } = {}) {
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('class', `pf-art${anim ? ` pfa-${anim}` : ''}`);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    el.innerHTML = inner;
    const k = scaled ? ' * var(--pf-k)' : '';
    el.style.cssText =
      `left:calc(50% + ${box.x}%${k});top:calc(50% + ${box.y}%${k});width:calc(${box.w}%${k});height:calc(${box.h}%${k});z-index:${z};` +
      `transform-origin:${f1(((origin[0] - box.x) / box.w) * 100)}% ${f1(((origin[1] - box.y) / box.h) * 100)}%`;
    for (const [name, value] of Object.entries(vars ?? {})) el.style.setProperty(`--${name}`, value);
    return el;
  }

  /** Destello de cuatro puntas que aparece y desaparece en (x, y). */
  function sparkle(x, y, size, color, dur, delay) {
    const s = size;
    const star = `M0 ${-s}Q${f1(s * 0.16)} ${f1(-s * 0.16)} ${s} 0Q${f1(s * 0.16)} ${f1(s * 0.16)} 0 ${s}Q${f1(-s * 0.16)} ${f1(s * 0.16)} ${-s} 0Q${f1(-s * 0.16)} ${f1(-s * 0.16)} 0 ${-s}Z`;
    return layer(`<g transform="translate(${f1(x)} ${f1(y)})"><path d="${star}" fill="${color}"/><circle r="${f1(s * 0.26)}" fill="#fff"/></g>`, {
      box: { x: f1(x - s), y: f1(y - s), w: 2 * s, h: 2 * s },
      z: 6,
      anim: 'twinkle',
      vars: { d: dur, dl: delay },
      origin: [x, y],
    });
  }

  /** Aro circular de metal (también el de todos los bordes en sitios estrechos). */
  function ringSvg(spec, { metal = spec.metal, r = 53, w = 6.5, studs = 0, studColor = null } = {}) {
    const p = nextId();
    const stops = METALS[metal];
    let svg =
      `<defs>${gradient(`${p}r`, stops, { x2: 1, y2: 1 })}</defs>` +
      `<circle r="${r}" fill="none" stroke="url(#${p}r)" stroke-width="${w}"/>` +
      `<circle r="${f1(r + w / 2 + 0.2)}" fill="none" stroke="${spec.edge}" stroke-width="1.1"/>` +
      `<circle r="${f1(r - w / 2 - 0.2)}" fill="none" stroke="${spec.edge}" stroke-width="1"/>`;
    for (const i of range(studs)) {
      const [x, y] = polar(r, (i / studs) * 360 + 180 / studs);
      svg += `<circle cx="${f1(x)}" cy="${f1(y)}" r="1.6" fill="${studColor ?? stops[0]}" stroke="${spec.edge}" stroke-width=".5"/>`;
    }
    return svg;
  }

  function neonRing(spec) {
    return layer(
      `<circle r="53" fill="none" stroke="${spec.pink}" stroke-width="9" opacity=".22"/><circle r="53" fill="none" stroke="${spec.pink}" stroke-width="2.6"/>` +
        `<circle r="58.5" fill="none" stroke="${spec.cyan}" stroke-width="6" opacity=".18"/><circle r="58.5" fill="none" stroke="${spec.cyan}" stroke-width="1.6"/>`,
      { anim: 'neon', vars: { d: '5s' } }
    );
  }

  const BUILDERS = {
    hexagono(spec) {
      const hex = (r) => pts(range(6).map((k) => polar(r, -90 + 60 * k)));
      const a = nextId();
      const b = nextId();
      const plate = layer(
        `<defs>${gradient(`${a}g`, METALS[spec.metal], { reverse: true })}</defs>` +
          `<polygon points="${hex(66)}" fill="url(#${a}g)" stroke="${spec.edge}" stroke-width="1.5" stroke-linejoin="round"/>`,
        { z: 1 }
      );
      let frame =
        `<defs>${gradient(`${b}g`, METALS[spec.metal], { x2: 1, y2: 1 })}</defs>` +
        `<polygon points="${hex(60)}" fill="none" stroke="url(#${b}g)" stroke-width="7" stroke-linejoin="round"/>` +
        `<polygon points="${hex(56.4)}" fill="none" stroke="${spec.edge}" stroke-width="1"/><polygon points="${hex(63.6)}" fill="none" stroke="${spec.edge}" stroke-width="1"/>`;
      for (const k of range(6)) {
        const [x, y] = polar(60, -90 + 60 * k);
        frame += `<circle cx="${f1(x)}" cy="${f1(y)}" r="2.4" fill="${METALS[spec.metal][0]}" stroke="${spec.edge}" stroke-width=".6"/>`;
      }
      return {
        back: [plate],
        front: [layer(frame), sparkle(...polar(64, -30), 7, '#ffffff', '2.8s', '0s'), sparkle(...polar(64, 150), 6, '#ffffff', '2.8s', '-1.4s')],
      };
    },

    laurel(spec) {
      const leaf = 'M0 0C5 -5.5 13 -5.5 18 0C13 5.5 5 5.5 0 0Z';
      const branch = (mirror) => {
        const p = nextId();
        let svg = `<defs>${gradient(`${p}l`, METALS[spec.metal])}</defs><g${mirror ? ' transform="scale(-1 1)"' : ''}>`;
        svg += `<path d="M${pt(polar(63, 98))}A63 63 0 0 1 ${pt(polar(63, 236))}" fill="none" stroke="${spec.edge}" stroke-width="2.2"/>`;
        for (let a = 104; a <= 226; a += 13) {
          const [x, y] = polar(63, a);
          for (const tilt of [-34, 34]) {
            svg +=
              `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(a + 90 + tilt)})"><path d="${leaf}" fill="url(#${p}l)" stroke="${spec.edge}" stroke-width=".8"/>` +
              `<path d="M2 0L15 0" stroke="rgba(255,255,255,.45)" stroke-width=".6"/></g>`;
          }
        }
        const [tx, ty] = polar(63, 236);
        svg += `<g transform="translate(${f1(tx)} ${f1(ty)}) rotate(${236 + 90})"><path d="${leaf}" fill="url(#${p}l)" stroke="${spec.edge}" stroke-width=".8"/></g></g>`;
        return layer(svg, { box: BIG, anim: 'sway', vars: { a: '2.5deg', d: '3.4s', dl: mirror ? '-1.7s' : '0s' }, origin: [0, 62] });
      };
      const bow =
        `<path d="M0 63C-10 53 -24 56 -20 66C-17 73 -7 69 0 63Z" fill="${spec.ribbon}" stroke="#4a0a12" stroke-width="1"/>` +
        `<path d="M0 63C10 53 24 56 20 66C17 73 7 69 0 63Z" fill="${spec.ribbon}" stroke="#4a0a12" stroke-width="1"/>` +
        `<path d="M-3 64L-12 82L-6 79L-2 85Z" fill="${spec.ribbon}" stroke="#4a0a12" stroke-width=".8"/><path d="M3 64L12 82L6 79L2 85Z" fill="${spec.ribbon}" stroke="#4a0a12" stroke-width=".8"/>` +
        `<circle cy="63" r="4.2" fill="${spec.ribbon}" stroke="#4a0a12"/><path d="M-12 59Q-8 57 -5 60" stroke="rgba(255,255,255,.4)" fill="none"/>`;
      return { back: [], front: [layer(ringSvg(spec)), branch(false), branch(true), layer(bow, { box: BIG, z: 4 }), shineEl()] };
    },

    engranaje(spec) {
      const p = nextId();
      const teeth = 14;
      const outline = range(teeth).flatMap((i) => {
        const c = (i / teeth) * 360;
        return [polar(57, c - 11), polar(67, c - 6), polar(67, c + 6), polar(57, c + 11)];
      });
      const gear = layer(
        `<defs>${gradient(`${p}g`, METALS[spec.metal], { x2: 1, y2: 1 })}</defs>` +
          `<polygon points="${pts(outline)}" fill="url(#${p}g)" stroke="${spec.edge}" stroke-width="1.4" stroke-linejoin="round"/>` +
          `<circle r="57" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="3"/>`,
        { z: 1, anim: 'spin', vars: { d: '22s' } }
      );
      return { back: [gear], front: [layer(ringSvg(spec, { metal: spec.ring, r: 52.5, w: 4.5, studs: 4 })), shineEl()] };
    },

    escudo(spec) {
      const p = nextId();
      const q = nextId();
      const sword =
        // Cruzadas detrás del escudo: la hoja asoma por arriba y la empuñadura por abajo.
        `<g transform="rotate(-60)"><path d="M-52 -4.5L104 -3.2L120 0L104 3.2L-52 4.5Z" fill="url(#${p}b)" stroke="#2a3340" stroke-width="1"/>` +
        `<path d="M-48 0L102 0" stroke="rgba(255,255,255,.65)" stroke-width="1"/>` +
        `<rect x="-60" y="-16" width="7" height="32" rx="2" fill="url(#${p}h)" stroke="#5a3a06"/>` +
        `<rect x="-80" y="-3.4" width="20" height="6.8" rx="2" fill="#4a2a14" stroke="#2a1608"/>` +
        `<circle cx="-84" r="5.4" fill="url(#${p}h)" stroke="#5a3a06"/></g>`;
      const swords = layer(
        `<defs>${gradient(`${p}b`, METALS.silver)}${gradient(`${p}h`, METALS.gold, { x2: 1, y2: 1 })}</defs>${sword}<g transform="scale(-1 1)">${sword}</g>`,
        { box: BIG, z: 0 }
      );
      const shieldPath = 'M-60 -58Q0 -74 60 -58L60 6Q58 54 0 82Q-58 54 -60 6Z';
      const shield = layer(
        `<defs>${gradient(`${q}s`, METALS[spec.metal])}</defs>` +
          `<path d="${shieldPath}" fill="url(#${q}s)" stroke="${spec.edge}" stroke-width="2" stroke-linejoin="round"/>` +
          `<path d="${shieldPath}" transform="translate(0 4) scale(.9)" fill="none" stroke="${METALS[spec.metal][0]}" stroke-width="1.6" opacity=".7"/>` +
          `<path d="M0 66L6 74L0 80L-6 74Z" fill="${spec.gem}" stroke="${spec.edge}"/>`,
        { box: BIG, z: 1 }
      );
      return {
        back: [swords, shield],
        front: [
          layer(ringSvg(spec, { metal: spec.ring, r: 52.5, w: 4.5 })),
          shineEl(),
          sparkle(60, -104, 7, '#ffffff', '2.4s', '0s'),
          sparkle(-60, -104, 7, '#ffffff', '2.4s', '-1.2s'),
        ],
      };
    },

    loto(spec) {
      const petal = 'M44 0C55 -14 72 -13 86 0C72 13 55 14 44 0Z';
      const ring = (offset, reverse) => {
        const p = nextId();
        let svg = `<defs>${gradient(`${p}p`, METALS[spec.metal], { reverse })}</defs>`;
        for (const k of range(12)) {
          svg +=
            `<g transform="rotate(${k * 30 + offset})"><path d="${petal}" fill="url(#${p}p)" stroke="${spec.edge}" stroke-width="1" stroke-linejoin="round"/>` +
            `<path d="M48 0L80 0" stroke="rgba(255,255,255,.4)" stroke-width=".8"/></g>`;
        }
        return svg;
      };
      return {
        back: [
          layer(ring(15, true), { box: BIG, z: 0, anim: 'spin', vars: { d: '60s' } }),
          layer(ring(0, false), { box: BIG, z: 1, anim: 'breath', vars: { d: '3s', s0: '.95', s1: '1.04' } }),
        ],
        front: [layer(ringSvg(spec, { studs: 12, studColor: '#f4fff9' })), shineEl(), sparkle(...polar(84, -60), 6, '#e8fff4', '3s', '-.8s')],
      };
    },

    neon(spec) {
      const glow = (d, color, w) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w * 3.4}" opacity=".22" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
      const ear = (mirror, delay) => {
        const outer = `M${pt(polar(55, -152))}L-60 -86L${pt(polar(55, -110))}`;
        const inner = `M${pt(polar(57, -144))}L-52 -74L${pt(polar(57, -119))}`;
        const svg =
          `<g${mirror ? ' transform="scale(-1 1)"' : ''}><path d="${outer}Z" fill="${spec.pink}" opacity=".12"/>` + glow(outer, spec.pink, 2.6) + glow(inner, spec.cyan, 1.6) + '</g>';
        const base = polar(55, -131);
        return layer(svg, { box: BIG, anim: 'twitch', vars: { a: mirror ? '10deg' : '-10deg', d: '5s', dl: delay }, origin: [mirror ? -base[0] : base[0], base[1]] });
      };
      const side = 'M-58 4L-90 -5M-58 12L-93 12M-58 20L-90 29';
      const whiskers = layer(glow(side, spec.cyan, 2) + `<g transform="scale(-1 1)">${glow(side, spec.cyan, 2)}</g>`, { box: BIG, anim: 'neon', vars: { d: '6s', dl: '-2s' } });
      return { back: [], front: [neonRing(spec), ear(false, '0s'), ear(true, '-2.3s'), whiskers, sparkle(...polar(76, -40), 5, spec.cyan, '2.2s', '-1s')] };
    },

    tormenta(spec) {
      const bolt = (a, len) =>
        `<g transform="rotate(${a})"><polyline points="56,0 66,-6 64,1 76,-5 73,3 ${len},0" fill="none" stroke="${spec.bolt}" stroke-width="9" opacity=".45" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<polyline points="56,0 66,-6 64,1 76,-5 73,3 ${len},0" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/></g>`;
      const set = (angles, delay) =>
        layer(angles.map((a, i) => bolt(a, i % 2 ? 90 : 100)).join(''), { box: BIG, z: 4, anim: 'flash', vars: { d: '2.4s', dl: delay } });
      return {
        back: [],
        front: [
          layer(`<circle r="53" fill="none" stroke="${spec.glow}" stroke-width="11" opacity=".35"/>`, { anim: 'pulse', vars: { d: '1.6s' } }),
          layer(`<circle r="53" fill="none" stroke="#16233a" stroke-width="7"/><circle r="53" fill="none" stroke="${spec.bolt}" stroke-width="3"/><circle r="56.7" fill="none" stroke="${spec.edge}"/><circle r="49.3" fill="none" stroke="${spec.edge}"/>`),
          layer(`<circle r="60" fill="none" stroke="${spec.glow}" stroke-width="1.6" stroke-dasharray="2 7" stroke-linecap="round" opacity=".9"/>`, { z: 4, anim: 'spin', vars: { d: '6s' } }),
          set([-60, 30, 140, 215], '0s'),
          set([-125, -15, 75, 175], '-1.2s'),
          sparkle(...polar(70, -100), 6, spec.glow, '1.8s', '-.4s'),
        ],
      };
    },

    llamas(spec) {
      const flames = (count, offset, base, extra, stops) => {
        const p = nextId();
        let svg =
          `<defs><linearGradient id="${p}f" gradientUnits="userSpaceOnUse" x1="44" y1="0" x2="${base + extra}" y2="0">` +
          stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('') +
          '</linearGradient></defs>';
        for (const k of range(count)) {
          const a = (k / count) * 360 + offset - 90;
          const L = f1(base + extra * Math.max(0, -Math.sin(toRad(a))));
          svg += `<path transform="rotate(${f1(a)})" d="M44 -12C58 -16 ${f1(L - 16)} -10 ${L} 0C${f1(L - 14)} 3 ${f1(L - 22)} 1 ${f1(L - 27)} 7C58 14 50 13 44 12Z" fill="url(#${p}f)"/>`;
        }
        return svg;
      };
      return {
        back: [
          layer(flames(14, 0, 76, 26, [[0, '#ffd34d'], [0.45, '#ff7a1a'], [0.85, '#c4160a'], [1, '#7a0a04', 0.6]]), { box: BIG, z: 0, anim: 'breath', vars: { d: '.9s', s0: '.94', s1: '1.06' } }),
          layer(flames(14, 360 / 28, 64, 14, [[0, '#fffbe0'], [0.5, '#ffd34d'], [1, '#ff7a1a', 0.7]]), { box: BIG, z: 1, anim: 'breath', vars: { d: '.9s', dl: '-.45s', s0: '.92', s1: '1.05' } }),
        ],
        front: [layer(ringSvg(spec, { r: 53, w: 6.5, studs: 10, studColor: '#ffd34d' })), shineEl(), orbitEl(spec)],
      };
    },

    hielo(spec) {
      const shard = (x, y, angle, L, w) =>
        `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(angle)})"><path d="M0 0L${f1(L * 0.38)} ${-w}L${L} 0L${f1(L * 0.38)} ${w}Z" fill="url(#ID)" stroke="rgba(255,255,255,.85)" stroke-width=".8" stroke-linejoin="round"/>` +
        `<path d="M2 0L${f1(L * 0.9)} 0" stroke="rgba(255,255,255,.7)" stroke-width=".7"/></g>`;
      const p = nextId();
      let crown = '';
      for (const k of range(12)) {
        const a = k * 30 - 90;
        const long = k % 2 === 0;
        const L = (long ? 46 : 26) + (long ? 6 : 0) * Math.max(0, -Math.sin(toRad(a)));
        crown += shard(...polar(46, a), a, L, long ? 7 : 5);
      }
      const q = nextId();
      const top = shard(0, -50, -90, 46, 8) + shard(-12, -50, -118, 34, 6) + shard(12, -50, -62, 34, 6);
      return {
        back: [layer(`<defs>${gradient(`${p}i`, METALS.ice)}</defs>${crown.replaceAll('ID', `${p}i`)}`, { box: BIG, z: 0, anim: 'sway', vars: { a: '3deg', d: '6s' } })],
        front: [
          layer(ringSvg(spec, { studs: 8, studColor: '#ffffff' })),
          shineEl(),
          layer(`<defs>${gradient(`${q}i`, METALS.ice, { reverse: true })}</defs>${top.replaceAll('ID', `${q}i`)}`, { box: BIG, z: 4 }),
          sparkle(-40, -78, 6, '#ffffff', '2.6s', '0s'),
          sparkle(44, -70, 5, '#e6f8ff', '2.6s', '-.9s'),
          sparkle(78, 20, 6, '#ffffff', '2.6s', '-1.7s'),
          sparkle(-80, 30, 5, '#e6f8ff', '2.6s', '-.4s'),
        ],
      };
    },

    dragon(spec) {
      const p = nextId();
      const horn = `<path d="M-18 -47C-26 -62 -34 -76 -46 -100C-36 -86 -24 -72 -5 -54Z" fill="url(#${p}h)" stroke="#5a4a2a" stroke-width="1.2" stroke-linejoin="round"/><path d="M-25 -58l6 -3M-31 -70l6 -3M-37 -82l5 -3" stroke="#8a774e" stroke-width="1.2"/>`;
      const horns = layer(
        `<defs>${gradient(`${p}h`, METALS.ivory, { x2: 1, y2: 1 })}</defs>${horn}<g transform="scale(-1 1)">${horn}</g>` +
          `<path d="M0 -66L6 -56L0 -47L-6 -56Z" fill="${spec.gem}" stroke="${spec.edge}"/>`,
        { box: BIG, z: 4 }
      );
      const t = nextId();
      const tail = layer(
        `<defs>${gradient(`${t}t`, METALS.crimson, { x2: 1, y2: 1 })}</defs>` +
          `<path d="M36 40C64 66 30 98 -14 88C-40 82 -56 72 -64 60" fill="none" stroke="${spec.edge}" stroke-width="9" stroke-linecap="round"/>` +
          `<path d="M36 40C64 66 30 98 -14 88C-40 82 -56 72 -64 60" fill="none" stroke="url(#${t}t)" stroke-width="6.5" stroke-linecap="round"/>` +
          `<path d="M-64 60L-80 50L-72 68L-58 72Z" fill="url(#${t}t)" stroke="${spec.edge}" stroke-width="1.2" stroke-linejoin="round"/>`,
        { box: BIG, z: 0, anim: 'sway', vars: { a: '4deg', d: '3s' }, origin: [36, 40] }
      );
      return {
        back: [tail, wingEl(spec, 'l', false, batWingShape), wingEl(spec, 'r', false, batWingShape)],
        front: [layer(ringSvg(spec, { studs: 12, studColor: spec.gem })), shineEl(), horns, orbitEl(spec)],
      };
    },

    galaxia(spec) {
      const p = nextId();
      const blob = (id, color) => `<radialGradient id="${p}${id}"><stop offset="0" stop-color="${color}" stop-opacity=".8"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
      const nebula = layer(
        `<defs>${blob('a', '#b06bff')}${blob('b', '#3fa9ff')}${blob('c', '#ff5fb8')}</defs>` +
          `<ellipse rx="104" ry="44" fill="url(#${p}a)" transform="rotate(-25)"/><ellipse rx="94" ry="36" fill="url(#${p}b)" transform="rotate(35)"/><ellipse rx="70" ry="62" fill="url(#${p}c)" opacity=".55"/>`,
        { box: BIG, z: 0, anim: 'spin', vars: { d: '40s' } }
      );
      // Estrellas fijas, siempre en el mismo sitio (pseudoaleatorio con semilla).
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      let stars = '';
      for (const _ of range(34)) {
        const [x, y] = polar(56 + rnd() * 48, rnd() * 360);
        stars += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(0.5 + rnd() * 0.9)}" fill="#ffffff" opacity="${f1(0.4 + rnd() * 0.6)}"/>`;
      }
      const planet = (svg, d, reverse) => layer(svg, { box: BIG, z: 5, anim: reverse ? 'spin-rev' : 'spin', vars: { d } });
      const g = nextId();
      return {
        back: [
          nebula,
          layer(stars, { box: BIG, z: 0, anim: 'pulse', vars: { d: '2.6s' } }),
          layer('<circle r="72" fill="none" stroke="rgba(255,255,255,.2)" stroke-width=".8" stroke-dasharray="2 4"/><circle r="92" fill="none" stroke="rgba(255,255,255,.14)" stroke-width=".8" stroke-dasharray="2 5"/>', { box: BIG, z: 1 }),
        ],
        front: [
          layer(ringSvg(spec, { studs: 16, studColor: '#ffffff' })),
          shineEl(),
          planet(`<defs><radialGradient id="${g}p" cx=".35" cy=".35"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#1f5fd6"/></radialGradient></defs><circle cx="72" r="6.5" fill="url(#${g}p)"/>`, '10s', false),
          planet(
            `<defs><radialGradient id="${g}q" cx=".35" cy=".35"><stop offset="0" stop-color="#ffe2b0"/><stop offset="1" stop-color="#c25a14"/></radialGradient></defs>` +
              `<g transform="translate(0 -92)"><circle r="7.5" fill="url(#${g}q)"/><ellipse rx="14" ry="4" fill="none" stroke="#ffd9a0" stroke-width="1.6" transform="rotate(-20)"/></g>`,
            '18s',
            true
          ),
          planet('<circle cy="62" r="3" fill="#ecebff"/>', '6s', false),
          sparkle(-70, -60, 6, '#ff9be0', '2.4s', '-.6s'),
          sparkle(84, 40, 5, '#9fe0ff', '2.4s', '-1.5s'),
        ],
      };
    },

    sol(spec) {
      const rays = (count, offset, lenA, lenB, half, stops, opacity) => {
        const p = nextId();
        let svg =
          `<defs><radialGradient id="${p}s" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${lenA}">` +
          stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('') +
          '</radialGradient></defs>';
        for (const k of range(count)) {
          const a = (k / count) * 360 + offset;
          const L = k % 2 ? lenB : lenA;
          svg += `<polygon points="${pts([polar(48, a - half), polar(L, a), polar(48, a + half)])}" fill="url(#${p}s)" opacity="${opacity}"/>`;
        }
        return svg;
      };
      return {
        back: [
          layer(rays(16, 0, 108, 80, 6, [[0.44, '#fff3b0'], [0.72, '#ffb72e'], [1, '#ff7a00', 0.2]], 1), { box: BIG, z: 0, anim: 'spin', vars: { d: '30s' } }),
          layer(rays(16, 11.25, 94, 94, 2.5, [[0.5, '#ffffff'], [1, '#ffd34d', 0]], 0.6), { box: BIG, z: 1, anim: 'spin-rev', vars: { d: '46s' } }),
        ],
        front: [
          layer(ringSvg(spec, { w: 7.5, studs: 12, studColor: '#fff3b0' })),
          shineEl(),
          layer('<circle r="59" fill="none" stroke="#fff3b0" stroke-width="8" opacity=".25"/><circle r="59" fill="none" stroke="#fff3b0" stroke-width="2"/>', { z: 4, anim: 'pulse', vars: { d: '1.8s' } }),
          orbitEl(spec),
        ],
      };
    },
  };

  const has = (id) => typeof id === 'string' && Object.hasOwn(FRAMES, id);
  const tierOf = (id) => (has(id) ? FRAMES[id].tier : null);

  /** Capas de un borde completo: { back: debajo de la foto, front: encima }. */
  function fullLayers(spec) {
    if (spec.kind) return BUILDERS[spec.kind](spec);
    const back = [];
    if (spec.low) back.push(wingEl(spec, 'l', true), wingEl(spec, 'r', true));
    back.push(wingEl(spec, 'l', false), wingEl(spec, 'r', false));
    const front = [ringEl(spec), shineEl()];
    if (spec.orbit) front.push(orbitEl(spec));
    return { back, front };
  }

  /** En sitios estrechos solo el aro (sin alas ni adornos que se salgan). */
  function compactLayers(spec) {
    if (!spec.kind) return { back: [], front: [ringEl(spec), shineEl()] };
    if (spec.kind === 'neon') return { back: [], front: [neonRing(spec)] };
    return { back: [], front: [layer(ringSvg(spec, { metal: spec.ring ?? spec.metal })), shineEl()] };
  }

  /**
   * Envuelve un avatar con su borde. Sin borde (o desconocido) devuelve el avatar tal cual.
   * `wings: false` para sitios estrechos (chat, barra superior, filas del ranking): solo el aro.
   */
  function wrap(avatar, id, { wings = true } = {}) {
    if (!has(id)) return avatar;
    const spec = FRAMES[id];
    const el = document.createElement('span');
    el.className = `pf pf-${spec.tier}${wings ? '' : ' pf-compact'}`;
    el.dataset.frame = id;
    if (spec.aura) el.style.setProperty('--pf-aura', spec.aura);
    const { back, front } = wings ? fullLayers(spec) : compactLayers(spec);
    if (wings && spec.aura) {
      const aura = document.createElement('span');
      aura.className = 'pf-aura';
      aura.setAttribute('aria-hidden', 'true');
      el.append(aura);
    }
    el.append(...back, avatar, ...front);
    return el;
  }

  return { wrap, has, tierOf, ids: Object.keys(FRAMES) };
})();
