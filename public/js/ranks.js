'use strict';

// Rangos (por créditos apostados en total) y ranking del top 10 por créditos.
// Los emblemas son SVG generados aquí: cada rango tiene forma y color propios, más
// elaborados cuanto más alto; las divisiones (I, II, III) son 1–3 gemas debajo.
window.RankUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => n.toLocaleString('es');
  const REFRESH_MS = 15_000;

  const PALETTES = {
    aprendiz: { light: '#c3c8cf', dark: '#5b6068', accent: '#eef0f3', ink: '#3d4148' },
    jugador: { light: '#eaa775', dark: '#84401b', accent: '#ffd8b8', ink: '#5a2a10' },
    apostador: { light: '#f7f9fc', dark: '#7f8b9c', accent: '#ffffff', ink: '#a01f33' },
    tahur: { light: '#ffe592', dark: '#a8721b', accent: '#fff6cf', ink: '#5c3d08' },
    as: { light: '#6ef3b6', dark: '#0a6e45', accent: '#d2ffe9', ink: '#064a2e' },
    magnate: { light: '#93ccff', dark: '#1b47a8', accent: '#e2f2ff', ink: '#0f2c6b' },
    baron: { light: '#ddb3ff', dark: '#6327ad', accent: '#f4e6ff', ink: '#3b1270' },
    leyenda: { light: '#ff9494', dark: '#9c0f2b', accent: '#ffe0e0', ink: '#5c0517' },
    mito: { light: '#ffe08a', dark: '#7a5cff', accent: '#ffffff', ink: '#2a1660' },
  };

  let uid = 0;
  let me = null; // mi rango (con progreso), del servidor
  let tiers = null; // tabla de rangos (umbrales), de /api/ranks
  let ctx;
  let active = false;
  let timer = null;

  // ---------- emblemas ----------

  const SHIELD = 'M32 7 L51 14 V30 C51 43 43 52 32 57 C21 52 13 43 13 30 V14 Z';
  const CROWN = 'M20 15 L21.5 5 L27 10.5 L32 3 L37 10.5 L42.5 5 L44 15 Z';
  const poly = (n, r, rot = -90, cx = 32, cy = 30) =>
    Array.from({ length: n }, (_, k) => {
      const a = ((rot + (360 / n) * k) * Math.PI) / 180;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const scaled = (d, s, cy = 30) => `<path d="${d}" transform="translate(32 ${cy}) scale(${s}) translate(-32 -${cy})"`;
  const glyph = (ch, fill, size = 18, y = 30, font = "'Segoe UI Symbol','Apple Symbols','Noto Sans Symbols',sans-serif") =>
    `<text x="32" y="${y + size * 0.36}" text-anchor="middle" font-size="${size}" font-family="${font}" font-weight="700" fill="${fill}">${ch}</text>`;
  const wing = (fill, stroke) =>
    `<path d="M16 26 C8 24 3 18 3 11 C8 16 12 18 17 20 C10 20 6 23 4 27 C9 27 13 28 17 31 C11 32 8 35 7 39 C12 37 15 36 19 36 Z" fill="${fill}" stroke="${stroke}" stroke-width=".8"/>`;

  const SHAPES = {
    aprendiz: (id, p) => `
      <circle cx="32" cy="30" r="23" fill="url(#${id}g)" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
      ${Array.from({ length: 8 }, (_, k) => `<rect x="29" y="7.5" width="6" height="6" rx="1" fill="${p.accent}" opacity=".85" transform="rotate(${k * 45} 32 30)"/>`).join('')}
      <circle cx="32" cy="30" r="13" fill="none" stroke="${p.accent}" stroke-opacity=".75" stroke-width="2"/>
      <circle cx="32" cy="30" r="5" fill="${p.accent}"/>`,
    jugador: (id, p) => `
      <circle cx="32" cy="30" r="24" fill="url(#${id}g)" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/>
      <circle cx="32" cy="30" r="19" fill="none" stroke="${p.accent}" stroke-width="4" stroke-dasharray="5 4"/>
      <circle cx="32" cy="30" r="13" fill="${p.dark}" stroke="${p.accent}" stroke-width="1.5"/>
      ${glyph('♣', p.accent, 16)}`,
    apostador: (id, p) => `
      <polygon points="${poly(6, 26)}" fill="url(#${id}g)" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
      <polygon points="${poly(6, 19)}" fill="none" stroke="${p.dark}" stroke-opacity=".7" stroke-width="2"/>
      ${glyph('♥', p.ink, 19)}`,
    tahur: (id, p) => `
      <path d="${SHIELD}" fill="url(#${id}g)" stroke="${p.ink}" stroke-width="1.5"/>
      ${scaled(SHIELD, 0.74, 31)} fill="none" stroke="${p.accent}" stroke-width="2"/>
      ${glyph('♠', p.ink, 22, 30)}`,
    as: (id, p) => `
      <path d="M32 2 L58 30 L32 58 L6 30 Z" fill="url(#${id}g)" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/>
      ${scaled('M32 2 L58 30 L32 58 L6 30 Z', 0.68)} fill="none" stroke="${p.accent}" stroke-width="2"/>
      ${glyph('A', '#fff', 22, 30, "'Cinzel',Georgia,serif")}`,
    magnate: (id, p) => `
      <g>${wing(`url(#${id}t)`, '#7a5714')}<g transform="translate(64 0) scale(-1 1)">${wing(`url(#${id}t)`, '#7a5714')}</g></g>
      <polygon points="${poly(8, 21, -67.5)}" fill="url(#${id}g)" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/>
      <polygon points="${poly(8, 15, -67.5)}" fill="none" stroke="${p.accent}" stroke-width="1.8"/>
      ${glyph('♦', p.accent, 18)}`,
    baron: (id, p) => `
      <path d="${CROWN}" fill="url(#${id}t)" stroke="#6b4a0e" stroke-width="1"/>
      <path d="M32 13 L50 19 V33 C50 45 42 53 32 58 C22 53 14 45 14 33 V19 Z" fill="url(#${id}g)" stroke="${p.ink}" stroke-width="1.5"/>
      ${scaled('M32 13 L50 19 V33 C50 45 42 53 32 58 C22 53 14 45 14 33 V19 Z', 0.72, 35)} fill="none" stroke="${p.accent}" stroke-width="1.8"/>
      ${glyph('♥', p.accent, 18, 35)}`,
    leyenda: (id, p) => `
      <g>${wing(`url(#${id}t)`, '#7a5714')}<g transform="translate(64 0) scale(-1 1)">${wing(`url(#${id}t)`, '#7a5714')}</g></g>
      <g transform="translate(0 -2) scale(1.08) translate(-2.4 0)">${wing(`url(#${id}t)`, '#7a5714')}</g>
      <g transform="translate(64 -2) scale(-1.08 1.08) translate(-2.4 0)">${wing(`url(#${id}t)`, '#7a5714')}</g>
      <circle cx="32" cy="32" r="17" fill="url(#${id}g)" stroke="url(#${id}t)" stroke-width="3"/>
      <path d="${CROWN}" transform="translate(32 9) scale(.7) translate(-32 -9)" fill="url(#${id}t)" stroke="#6b4a0e" stroke-width="1"/>
      ${glyph('★', '#fff', 17, 32)}`,
    mito: (id) => `
      <g class="rk-rays">
        ${Array.from({ length: 12 }, (_, k) => `<polygon points="32,30 ${k % 2 ? '30.2,6 33.8,6' : '29.6,1 34.4,1'}" fill="url(#${id}t)" transform="rotate(${k * 30} 32 30)"/>`).join('')}
      </g>
      <circle cx="32" cy="30" r="18" fill="url(#${id}p)" stroke="#fff" stroke-width="2"/>
      <circle cx="32" cy="30" r="12.5" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/>
      <path d="M32 17 Q33.6 28.4 45 30 Q33.6 31.6 32 43 Q30.4 31.6 19 30 Q30.4 28.4 32 17 Z" fill="#fff"/>`,
  };

  function emblemSvg(rank, withDivision) {
    const tier = PALETTES[rank.id] ? rank.id : 'aprendiz';
    const p = PALETTES[tier];
    const id = `rk${++uid}`;
    const pips =
      withDivision && rank.division
        ? Array.from({ length: rank.division }, (_, k) => {
            const x = 32 + (k - (rank.division - 1) / 2) * 9;
            return `<path d="M${x} 55.5 L${x + 3.6} 59.5 L${x} 63.5 L${x - 3.6} 59.5 Z" fill="${p.light}" stroke="#fff" stroke-width=".9"/>`;
          }).join('')
        : '';
    return `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.light}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
        <linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset=".5" stop-color="#d9a93c"/><stop offset="1" stop-color="#8a6516"/></linearGradient>
        <linearGradient id="${id}p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd36b"/><stop offset=".35" stop-color="#ff6bd6"/><stop offset=".7" stop-color="#7a6bff"/><stop offset="1" stop-color="#45e0ff"/></linearGradient>
      </defs>
      <g transform="translate(32 28) scale(.9) translate(-32 -30)">${SHAPES[tier](id, p)}</g>
      ${pips}
    </svg>`;
  }

  /**
   * Emblema de un rango ({ id, division, label }) como elemento, de `size` px.
   * `withDivision: false` lo dibuja sin las gemas (p. ej. en la tabla de rangos).
   */
  function emblem(rank, size = 24, { withDivision = true } = {}) {
    const el = document.createElement('span');
    el.className = `rank-emblem rank-${rank?.id ?? 'aprendiz'}`;
    el.style.setProperty('--s', `${size}px`);
    el.title = rank?.label ?? '';
    el.innerHTML = emblemSvg(rank ?? { id: 'aprendiz', division: 1 }, withDivision);
    return el;
  }

  // ---------- mi rango ----------

  function renderMine() {
    if (!me) return;
    $('#my-rank').replaceChildren(emblem(me, 22));
    document.querySelector('.user-chip').title = `Tu perfil · ID ${ctx.user.publicId} · ${me.label}`;

    const card = $('#my-rank-card');
    const pct = Math.floor(me.progress * 100);
    card.querySelector('.mr-emblem').replaceChildren(emblem(me, 112));
    card.querySelector('.mr-label').textContent = me.label;
    card.querySelector('.mr-label').className = `mr-label rank-text-${me.id}`;
    card.querySelector('.mr-wagered').textContent = `${fmt(me.wagered)} créditos apostados`;
    card.querySelector('.mr-bar').style.width = `${pct}%`;
    card.querySelector('.mr-next').textContent = me.next
      ? `Te faltan ${fmt(me.next.missing)} para ${me.next.label}`
      : 'Rango máximo alcanzado';
    renderLadder();
  }

  function onRank(rank) {
    const up = rank.up;
    me = rank;
    renderMine();
    if (up) {
      ctx.celebrate({ title: '¡Subiste de rango!', badge: emblem(rank, 150), detail: rank.label, big: rank.division === 1 || rank.division === null });
    }
  }

  // ---------- tabla de rangos ----------

  async function loadTiers() {
    if (tiers) return;
    try {
      tiers = (await ctx.api('/api/ranks')).tiers;
      renderLadder();
    } catch {
      // se reintenta al volver a abrir el ranking
    }
  }

  function renderLadder() {
    if (!tiers) return;
    $('#rank-ladder').replaceChildren(
      ...tiers
        .map((tier) => {
          const mine = me?.id === tier.id;
          const row = document.createElement('div');
          row.className = `ladder-row${mine ? ' mine' : ''}`;
          const name = document.createElement('span');
          name.className = `ladder-name rank-text-${tier.id}`;
          name.textContent = tier.name;
          const min = document.createElement('span');
          min.className = 'ladder-min';
          min.textContent = tier.divisions[0] === 0 ? 'Inicio' : `desde ${fmt(tier.divisions[0])}`;
          row.append(emblem({ id: tier.id, label: tier.name }, 34, { withDivision: false }), name, min);
          if (mine) {
            const you = document.createElement('span');
            you.className = 'ladder-you';
            you.textContent = me.division ? `Tú · ${['I', 'II', 'III'][me.division - 1]}` : 'Tú';
            row.append(you);
          }
          return row;
        })
        .reverse() // el más alto arriba
    );
  }

  // ---------- ranking ----------

  function person(entry, size) {
    const wrap = document.createElement('div');
    wrap.className = 'lb-person';
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = entry.username;
    name.title = `ID ${entry.publicId}`;
    wrap.append(ctx.avatar(entry.username, entry.avatar, size), name);
    return wrap;
  }

  function rankTag(rank) {
    const tag = document.createElement('span');
    tag.className = `lb-rank rank-text-${rank.id}`;
    tag.append(emblem(rank, 22), document.createTextNode(rank.label));
    return tag;
  }

  function credits(value) {
    const el = document.createElement('span');
    el.className = 'lb-credits';
    el.innerHTML = '<i class="bi bi-coin"></i>';
    el.append(document.createTextNode(fmt(value)));
    return el;
  }

  function renderBoard({ top, me: mine }) {
    const podium = $('#lb-podium');
    const order = [top[1], top[0], top[2]]; // 2.º · 1.º · 3.º
    podium.replaceChildren(
      ...order.map((entry, i) => {
        const place = [2, 1, 3][i];
        const col = document.createElement('div');
        col.className = `podium-col place-${place}${entry?.userId === ctx.user.id ? ' is-me' : ''}`;
        if (!entry) {
          col.classList.add('empty');
          return col;
        }
        const medal = document.createElement('span');
        medal.className = 'podium-medal';
        medal.textContent = place;
        const avatarSize = place === 1 ? 'lb-avatar-xl' : 'lb-avatar-lg';
        const block = document.createElement('div');
        block.className = 'podium-block';
        block.append(credits(entry.credits));
        col.append(medal, person(entry, avatarSize), rankTag(entry.rank), block);
        return col;
      })
    );

    const list = $('#lb-list');
    const rest = top.slice(3);
    list.replaceChildren(
      ...rest.map((entry) => {
        const li = document.createElement('li');
        li.className = `lb-row${entry.userId === ctx.user.id ? ' is-me' : ''}`;
        const pos = document.createElement('span');
        pos.className = 'lb-pos';
        pos.textContent = entry.position;
        li.append(pos, person(entry, 'lb-avatar'), rankTag(entry.rank), credits(entry.credits));
        return li;
      })
    );
    list.classList.toggle('hidden', rest.length === 0);

    const meEl = $('#lb-me');
    const inTop = top.some((e) => e.userId === ctx.user.id);
    meEl.replaceChildren();
    if (!inTop) {
      const pos = document.createElement('span');
      pos.className = 'lb-pos';
      pos.textContent = mine.position;
      const label = document.createElement('span');
      label.className = 'lb-name';
      label.textContent = 'Tu posición';
      meEl.append(pos, label, rankTag(mine.rank), credits(mine.credits));
    }
    meEl.classList.toggle('hidden', inTop);
    if (!top.length) $('#lb-empty').classList.remove('hidden');
    $('#lb-updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  async function refresh() {
    try {
      const data = await ctx.api('/api/leaderboard');
      renderBoard(data);
      onRank({ ...data.me.rank, up: false });
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  /** La pestaña de ranking se actualiza sola mientras está abierta. */
  function setActive(value) {
    active = value;
    clearInterval(timer);
    if (!active) return;
    loadTiers();
    refresh();
    timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
  }

  function init(appCtx) {
    ctx = appCtx;
    ctx.socket.on('rank', onRank);
  }

  return { init, emblem, setActive };
})();
