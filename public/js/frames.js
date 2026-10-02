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
    obsidian: ['#8f7bb8', '#1b1622', '#4a3f63', '#050407', '#2c2538'],
    seraph: ['#ffffff', '#e6d7aa', '#fffbf0', '#b3944b', '#f2e5c2'],
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

  function wingEl(spec, side, low) {
    const p = `pf${++uid}`;
    const metal = METALS[spec.metal];
    const { svg, box } = wingShape(spec, p, low);
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

  const has = (id) => typeof id === 'string' && Object.hasOwn(FRAMES, id);
  const tierOf = (id) => (has(id) ? FRAMES[id].tier : null);

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
    const layers = [];
    if (wings && spec.aura) {
      const aura = document.createElement('span');
      aura.className = 'pf-aura';
      aura.setAttribute('aria-hidden', 'true');
      layers.push(aura);
    }
    if (wings) {
      if (spec.low) layers.push(wingEl(spec, 'l', true), wingEl(spec, 'r', true));
      layers.push(wingEl(spec, 'l', false), wingEl(spec, 'r', false));
    }
    layers.push(avatar, ringEl(spec), shineEl());
    if (wings && spec.orbit) layers.push(orbitEl(spec));
    el.append(...layers);
    return el;
  }

  return { wrap, has, tierOf, ids: Object.keys(FRAMES) };
})();
