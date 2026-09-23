'use strict';

window.BlackjackUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const RESULT_LABEL = { win: 'Gana', lose: 'Pierde', push: 'Empate', blackjack: 'Blackjack' };
  const DEAL_MS = 420; // lo que tarda una carta en llegar desde el zapato
  const DEAL_GAP_MS = 140; // separación entre cartas que llegan en la misma actualización
  const FLIP_MS = 170; // media vuelta al descubrir la carta tapada
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let ctx;
  let state = null;
  let deadline = 0;
  let pendingBet = 0;

  // Contenedores de cartas persistentes (por mano), para animar solo lo nuevo
  // aunque el resto del asiento se vuelva a pintar.
  let cardWraps = new Map(); // key -> { el, cards }
  let animQueue = [];

  const rankValue = (r) => (r === 'A' ? 1 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r));
  const sameCard = (a, b) => a === b || (!!a && !!b && a.r === b.r && a.s === b.s);

  function mySeatIndex() {
    return state ? state.seats.findIndex((s) => s && s.userId === ctx.user.id) : -1;
  }

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function fillCard(el, card) {
    el.replaceChildren();
    if (!card) {
      el.className = 'card back';
      return el;
    }
    el.className = `card${card.s === '♥' || card.s === '♦' ? ' red' : ''}`;
    el.append(span('r', card.r), span('s', card.s));
    return el;
  }

  /**
   * Sincroniza las cartas de una mano con su contenedor y encola la animación
   * de las cartas nuevas (reparto) o destapadas (giro). Devuelve si hubo cambios.
   */
  function syncCards(key, cards, small = false) {
    let entry = cardWraps.get(key);
    if (!entry) {
      entry = { el: document.createElement('div'), cards: [] };
      cardWraps.set(key, entry);
    }
    const { el } = entry;
    el.className = small ? 'cards small' : 'cards';
    let changed = false;

    cards.forEach((card, i) => {
      const node = el.children[i];
      if (node && sameCard(entry.cards[i], card)) return;
      changed = true;
      if (node && entry.cards[i] === null && card) {
        animQueue.push({ type: 'flip', node, card });
        return;
      }
      const fresh = fillCard(document.createElement('div'), card);
      if (node) node.replaceWith(fresh);
      else el.appendChild(fresh);
      animQueue.push({ type: 'deal', node: fresh });
    });
    while (el.children.length > cards.length) el.lastElementChild.remove();

    entry.cards = cards.slice();
    return { el, changed };
  }

  function flip(node, card, delay) {
    const half = node.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration: FLIP_MS, delay, easing: 'ease-in', fill: 'forwards',
    });
    half.onfinish = () => {
      fillCard(node, card);
      half.cancel();
      node.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: FLIP_MS, easing: 'ease-out' });
    };
  }

  /** Lanza las animaciones encoladas en este render, una detrás de otra. */
  function runAnimations() {
    const items = animQueue;
    animQueue = [];
    if (reducedMotion.matches) {
      for (const it of items) if (it.type === 'flip') fillCard(it.node, it.card);
      return;
    }
    const shoe = $('#bj-shoe').getBoundingClientRect();
    const sx = shoe.left + shoe.width / 2;
    const sy = shoe.top + shoe.height / 2;
    let t = 0;
    let lastLanding = 0;

    for (const it of items) {
      if (it.type === 'deal') {
        const r = it.node.getBoundingClientRect();
        const dx = sx - (r.left + r.width / 2);
        const dy = sy - (r.top + r.height / 2);
        it.node.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) rotate(-100deg) scale(.8)`, boxShadow: '0 12px 24px rgba(0,0,0,.5)' },
            { transform: 'none' },
          ],
          { duration: DEAL_MS, delay: t, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }
        );
        lastLanding = t + DEAL_MS;
        t += DEAL_GAP_MS;
      } else if (it.type === 'flip') {
        flip(it.node, it.card, t);
        lastLanding = t + FLIP_MS * 2;
        t += DEAL_GAP_MS;
      } else if (it.type === 'reveal' && lastLanding) {
        // Los totales y resultados aparecen cuando la carta ya ha llegado.
        it.node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: lastLanding, fill: 'backwards' });
      }
    }
  }

  function seatEl(seat, i, mine) {
    const el = document.createElement('div');
    el.className = 'seat';

    if (!seat) {
      el.classList.add('empty');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost small';
      btn.textContent = 'Sentarse';
      btn.disabled = mine !== -1;
      btn.addEventListener('click', async () => {
        const res = await ctx.emit('bj:sit', { seat: i });
        if (!res.ok) ctx.toast(res.error, 'error');
      });
      el.append(span('seat-sub', `Asiento ${i + 1}`), btn);
      return el;
    }

    if (i === mine) el.classList.add('mine');
    if (state.turn === i) el.classList.add('turn');
    el.append(span('seat-name', seat.username + (i === mine ? ' (tú)' : '')));

    if (seat.hands.length === 0) {
      if (seat.bet > 0) el.append(span('seat-bet', `Apuesta ${seat.bet}`));
      else if (state.phase === 'waiting' || state.phase === 'betting') el.append(span('seat-sub', 'Apostando…'));
      else el.append(span('seat-sub', 'Espera la próxima mano'));
    }

    seat.hands.forEach((hand, k) => {
      const h = document.createElement('div');
      h.className = 'hand';
      if (state.turn === i && seat.activeHand === k) h.classList.add('active');
      const { el: cards, changed } = syncCards(`${i}-${k}`, hand.cards, seat.hands.length > 1);
      h.appendChild(cards);

      const info = document.createElement('div');
      info.className = 'hand-info';
      if (hand.cards.length) info.append(span('total', hand.total > 21 ? `${hand.total} ✗` : String(hand.total)));
      info.append(span('seat-bet', `${hand.bet}${hand.doubled ? ' ×2' : ''}`));
      if (hand.result) info.append(span(`res ${hand.result}`, RESULT_LABEL[hand.result]));
      h.appendChild(info);
      if (changed) animQueue.push({ type: 'reveal', node: info });
      el.appendChild(h);
    });

    if (seat.leaving) el.append(span('seat-sub', 'Se levanta al terminar'));
    return el;
  }

  function statusText(mine) {
    switch (state.phase) {
      case 'waiting': return state.seats.some(Boolean) ? 'Esperando apuestas' : 'Mesa libre, siéntate para jugar';
      case 'betting': return 'Apuestas abiertas · reparto en';
      case 'dealing': return 'Repartiendo…';
      case 'playing': {
        const seat = state.seats[state.turn];
        return state.turn === mine ? 'Tu turno' : `Turno de ${seat?.username ?? '…'}`;
      }
      case 'dealer': return 'Juega el crupier';
      case 'settled': return 'Resultados · nueva mano en';
      default: return '';
    }
  }

  function render() {
    const mine = mySeatIndex();
    const seat = mine === -1 ? null : state.seats[mine];

    if (state.phase === 'waiting') cardWraps = new Map();

    // Crupier
    const { el: dealerCards, changed } = syncCards('dealer', state.dealer.cards);
    const holder = $('#bj-dealer-cards');
    if (dealerCards.parentNode !== holder) holder.replaceChildren(dealerCards);
    const dealerTotal = $('#bj-dealer-total');
    dealerTotal.textContent = state.dealer.total ?? '';
    if (changed) animQueue.push({ type: 'reveal', node: dealerTotal });

    // Asientos
    const seats = $('#bj-seats');
    seats.replaceChildren(...state.seats.map((s, i) => seatEl(s, i, mine)));

    $('#bj-phase').textContent = statusText(mine);

    // Controles
    const canBet = seat && seat.bet === 0 && (state.phase === 'waiting' || state.phase === 'betting');
    const myTurn = seat && state.phase === 'playing' && state.turn === mine;
    $('#bj-bet').classList.toggle('hidden', !canBet);
    $('#bj-actions').classList.toggle('hidden', !myTurn);
    $('#bj-leave').classList.toggle('hidden', !seat || seat.leaving);

    if (myTurn) {
      const hand = seat.hands[seat.activeHand];
      const [a, b] = hand.cards;
      $('[data-action=double]').disabled = hand.cards.length !== 2 || hand.splitAces;
      $('[data-action=split]').disabled =
        seat.hands.length !== 1 || hand.cards.length !== 2 || rankValue(a.r) !== rankValue(b.r);
    }

    let hint = '';
    if (!seat) hint = state.seats.every(Boolean) ? 'La mesa está llena (6/6). Puedes mirar hasta que se libere un asiento.' : 'Elige un asiento libre para jugar.';
    else if (canBet) hint = `Elige tus fichas y pulsa Apostar (mín. ${state.limits.min}, máx. ${state.limits.max}).`;
    else if (seat.hands.length === 0 && seat.bet === 0) hint = 'Hay una mano en juego. Podrás apostar en la siguiente.';
    $('#bj-hint').textContent = hint;
    renderPending();

    runAnimations();
  }

  function renderPending() {
    $('#bj-pending').textContent = pendingBet;
    $('#bj-bet-place').disabled = pendingBet === 0;
  }

  function tick() {
    const el = $('#bj-timer');
    if (!state || state.endsIn === null || !['betting', 'playing', 'settled'].includes(state.phase)) {
      el.textContent = '';
      return;
    }
    el.textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s`;
  }

  function init(appCtx) {
    ctx = appCtx;

    ctx.renderChips($('#bj-chips'), (v) => {
      pendingBet = Math.min(state?.limits.max ?? 500, pendingBet + v);
      renderPending();
    });
    $('#bj-bet-clear').addEventListener('click', () => { pendingBet = 0; renderPending(); });
    $('#bj-bet-place').addEventListener('click', async () => {
      const res = await ctx.emit('bj:bet', { amount: pendingBet });
      if (!res.ok) return ctx.toast(res.error, 'error');
      pendingBet = 0;
      renderPending();
    });

    document.querySelectorAll('#bj-actions [data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await ctx.emit('bj:action', { action: btn.dataset.action });
        if (!res.ok) ctx.toast(res.error, 'error');
      });
    });

    $('#bj-leave').addEventListener('click', async () => {
      const res = await ctx.emit('bj:leave');
      if (!res.ok) ctx.toast(res.error, 'error');
    });

    ctx.socket.on('bj:state', (s) => {
      state = s;
      deadline = s.endsIn === null ? 0 : Date.now() + s.endsIn;
      render();
    });

    setInterval(tick, 200);
  }

  return { init };
})();
