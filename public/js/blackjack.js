'use strict';

window.BlackjackUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const RESULT_LABEL = { win: 'Gana', lose: 'Pierde', push: 'Empate', blackjack: 'Blackjack' };
  const DEAL_MS = 420; // lo que tarda una carta en llegar desde el zapato
  const DEAL_GAP_MS = 140; // separación entre cartas que llegan en la misma actualización
  const FLIP_MS = 190; // media vuelta al descubrir la carta tapada
  const TIMED_PHASES = ['betting', 'playing', 'settled'];

  let ctx;
  let state = null;
  let deadline = 0;
  let pendingBet = 0;

  // Contenedores de cartas persistentes (por mano), para animar solo lo nuevo
  // aunque el resto del asiento se vuelva a pintar.
  let cardWraps = new Map(); // key -> { el, cards }
  let animQueue = [];
  // Lo que ya se animó una vez, para no repetirlo en cada actualización.
  const shownResults = new Set();
  const shownBets = new Set();

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

  function timeLeftPct() {
    if (!state?.duration || state.endsIn === null) return 0;
    return (Math.max(0, deadline - Date.now()) / state.duration) * 100;
  }

  function fillCard(el, card) {
    el.replaceChildren();
    if (!card) {
      el.className = 'pcard back';
      return el;
    }
    el.className = `pcard${card.s === '♥' || card.s === '♦' ? ' red' : ''}`;
    const corner = (pos) => {
      const c = span(`corner ${pos}`, '');
      c.append(document.createElement('b'), document.createElement('i'));
      c.firstChild.textContent = card.r;
      c.lastChild.textContent = card.s;
      return c;
    };
    el.append(corner('tl'), span('pip', card.s), corner('br'));
    return el;
  }

  /**
   * Sincroniza las cartas de una mano con su contenedor y encola la animación
   * de las cartas nuevas (reparto) o destapadas (giro). Devuelve si hubo cambios.
   */
  function syncCards(key, cards, compact = false) {
    let entry = cardWraps.get(key);
    if (!entry) {
      entry = { el: document.createElement('div'), cards: [] };
      cardWraps.set(key, entry);
    }
    const { el } = entry;
    el.className = compact ? 'cards compact' : 'cards';
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
    const half = node.animate(
      [{ transform: 'perspective(700px) rotateY(0deg)' }, { transform: 'perspective(700px) rotateY(90deg)' }],
      { duration: FLIP_MS, delay, easing: 'ease-in', fill: 'forwards' }
    );
    half.onfinish = () => {
      fillCard(node, card);
      half.cancel();
      node.animate(
        [
          { transform: 'perspective(700px) rotateY(-90deg)' },
          { transform: 'perspective(700px) rotateY(0deg) scale(1.08)', offset: 0.7 },
          { transform: 'none' },
        ],
        { duration: FLIP_MS * 1.4, easing: 'ease-out' }
      );
    };
  }

  /** Lanza las animaciones encoladas en este render, una detrás de otra. */
  function runAnimations() {
    const items = animQueue;
    animQueue = [];
    if (ctx.reducedMotion.matches) {
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
            { transform: `translate(${dx}px, ${dy}px) rotate(-100deg) scale(.7)`, boxShadow: '0 14px 28px rgba(0,0,0,.5)' },
            { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 8}px) rotate(-8deg) scale(1.04)`, offset: 0.8 },
            { transform: 'none' },
          ],
          { duration: DEAL_MS, delay: t, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }
        );
        lastLanding = t + DEAL_MS;
        t += DEAL_GAP_MS;
      } else if (it.type === 'flip') {
        flip(it.node, it.card, t);
        lastLanding = t + FLIP_MS * 2.4;
        t += DEAL_GAP_MS;
      } else if (it.type === 'reveal' && lastLanding) {
        // Los totales aparecen cuando la carta ya ha llegado.
        it.node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: lastLanding, fill: 'backwards' });
      } else if (it.type === 'pop') {
        it.node.animate(
          [
            { transform: 'scale(.3)', opacity: 0 },
            { transform: 'scale(1.2)', opacity: 1, offset: 0.6 },
            { transform: 'scale(1)' },
          ],
          { duration: 480, delay: lastLanding, easing: 'ease-out', fill: 'backwards' }
        );
      }
    }
  }

  function totalEl(total) {
    return span(`total${total > 21 ? ' bust' : total === 21 ? ' twentyone' : ''}`, total > 21 ? `${total} ✗` : String(total));
  }

  function seatEl(seat, i, mine) {
    const el = document.createElement('div');
    el.className = 'seat';

    if (!seat) {
      el.classList.add('empty');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline-gold btn-sm';
      btn.innerHTML = '<i class="bi bi-plus-circle me-1"></i>Sentarse';
      btn.disabled = mine !== -1;
      btn.addEventListener('click', async () => {
        const res = await ctx.emit('bj:sit', { seat: i });
        if (!res.ok) ctx.toast(res.error, 'error');
      });
      el.append(span('seat-spot', String(i + 1)), btn);
      return el;
    }

    if (i === mine) el.classList.add('mine');
    if (state.turn === i) el.classList.add('turn');

    const plate = document.createElement('div');
    plate.className = 'seat-plate';
    plate.append(span('avatar', seat.username.slice(0, 1)), span('seat-name', seat.username));
    if (i === mine) plate.append(span('you-badge', 'tú'));
    el.append(plate);

    if (seat.hands.length === 0) {
      if (seat.bet > 0) {
        const chip = span('chip bet-chip', seat.bet);
        const key = `${i}:${seat.userId}:${seat.bet}`;
        if (shownBets.has(key)) chip.style.animation = 'none';
        shownBets.add(key);
        el.append(chip);
      } else if (state.phase === 'waiting' || state.phase === 'betting') {
        el.append(span('seat-sub', 'Apostando…'));
      } else {
        el.append(span('seat-sub', 'Espera la próxima mano'));
      }
    }

    let bet = 0;
    let payout = 0;
    seat.hands.forEach((hand, k) => {
      bet += hand.bet;
      payout += hand.payout;
      const h = document.createElement('div');
      h.className = 'hand';
      if (state.turn === i && seat.activeHand === k) h.classList.add('active');
      const { el: cards, changed } = syncCards(`${i}-${k}`, hand.cards, seat.hands.length > 1);
      h.appendChild(cards);

      const info = document.createElement('div');
      info.className = 'hand-info';
      if (hand.cards.length) info.append(totalEl(hand.total));
      info.append(span('seat-bet', `${hand.bet}${hand.doubled ? ' ×2' : ''}`));
      if (hand.result) {
        const badge = span(`res ${hand.result}`, RESULT_LABEL[hand.result]);
        const key = `${i}-${k}`;
        if (!shownResults.has(key)) {
          shownResults.add(key);
          animQueue.push({ type: 'pop', node: badge });
        }
        info.append(badge);
      }
      h.appendChild(info);
      if (changed) animQueue.push({ type: 'reveal', node: info });
      el.appendChild(h);
    });

    if (state.phase === 'settled' && seat.hands.length) {
      if (payout > bet) el.classList.add('won');
      else if (payout < bet) el.classList.add('lost');
    }
    if (seat.leaving) el.append(span('seat-sub', 'Se levanta al terminar'));
    if (state.turn === i && state.phase === 'playing') {
      const bar = document.createElement('div');
      bar.className = 'turn-bar';
      const fill = document.createElement('span');
      fill.style.width = `${timeLeftPct()}%`;
      bar.append(fill);
      el.append(bar);
    }
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

    if (state.phase === 'waiting') {
      cardWraps = new Map();
      shownResults.clear();
    }
    if (state.phase === 'dealing') shownBets.clear();

    // Crupier
    const { el: dealerCards, changed } = syncCards('dealer', state.dealer.cards);
    const holder = $('#bj-dealer-cards');
    if (dealerCards.parentNode !== holder) holder.replaceChildren(dealerCards);
    const dealerTotal = $('#bj-dealer-total');
    const total = state.dealer.total;
    dealerTotal.textContent = total ?? '';
    dealerTotal.className = `total${total > 21 ? ' bust' : total === 21 ? ' twentyone' : ''}`;
    if (changed) animQueue.push({ type: 'reveal', node: dealerTotal });

    // Asientos
    $('#bj-seats').replaceChildren(...state.seats.map((s, i) => seatEl(s, i, mine)));
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

  /** Celebra si la mano que acaba de terminar dejó ganancias. */
  function onSettled() {
    const seat = state.seats[mySeatIndex()];
    if (!seat || !seat.hands.length) return;
    const bet = seat.hands.reduce((sum, h) => sum + h.bet, 0);
    const payout = seat.hands.reduce((sum, h) => sum + h.payout, 0);
    if (payout <= bet) return;
    const blackjack = seat.hands.some((h) => h.result === 'blackjack');
    setTimeout(() => ctx.celebrate(payout, blackjack ? '¡Blackjack!' : '¡Ganas!', blackjack), 600);
  }

  function renderPending() {
    const el = $('#bj-pending');
    if (el.textContent !== String(pendingBet)) {
      el.textContent = pendingBet;
      el.animate?.([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 250, easing: 'ease-out' });
    }
    $('#bj-bet-place').disabled = pendingBet === 0;
  }

  function tick() {
    const timer = $('#bj-timer');
    const shown = state && state.endsIn !== null && TIMED_PHASES.includes(state.phase);
    const pct = shown ? timeLeftPct() : 0;
    const secs = Math.ceil(Math.max(0, deadline - Date.now()) / 1000);
    const urgent = shown && state.phase === 'playing' && secs <= 5;
    timer.textContent = shown ? `${secs}s` : '';
    timer.classList.toggle('urgent', urgent);

    const bar = $('#bj-progress');
    bar.style.width = `${pct}%`;
    bar.parentElement.classList.toggle('urgent', urgent);
    bar.parentElement.classList.toggle('invisible', !shown);
    const turnBar = $('#bj-seats .turn-bar');
    if (turnBar) {
      turnBar.firstElementChild.style.width = `${pct}%`;
      turnBar.classList.toggle('urgent', urgent);
    }
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
      const prevPhase = state?.phase;
      state = s;
      deadline = s.endsIn === null ? 0 : Date.now() + s.endsIn;
      render();
      if (s.phase === 'settled' && prevPhase && prevPhase !== 'settled') onSettled();
    });

    setInterval(tick, 150);
  }

  return { init };
})();
