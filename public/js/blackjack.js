'use strict';

window.BlackjackUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const RESULT_LABEL = { win: 'Gana', lose: 'Pierde', push: 'Empate', blackjack: 'Blackjack' };

  let ctx;
  let state = null;
  let deadline = 0;
  let pendingBet = 0;
  let renderedCounts = new Map(); // para animar solo las cartas nuevas

  const rankValue = (r) => (r === 'A' ? 1 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r));

  function mySeatIndex() {
    return state ? state.seats.findIndex((s) => s && s.userId === ctx.user.id) : -1;
  }

  function cardsEl(cards, key, small = false) {
    const wrap = document.createElement('div');
    wrap.className = small ? 'cards small' : 'cards';
    const before = renderedCounts.get(key) ?? 0;
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      if (!c) {
        el.className = 'card back';
      } else {
        el.className = `card${c.s === '♥' || c.s === '♦' ? ' red' : ''}`;
        const r = document.createElement('span');
        r.className = 'r';
        r.textContent = c.r;
        const s = document.createElement('span');
        s.className = 's';
        s.textContent = c.s;
        el.append(r, s);
      }
      if (i >= before) el.classList.add('new');
      wrap.appendChild(el);
    });
    renderedCounts.set(key, cards.length);
    return wrap;
  }

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
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
      h.appendChild(cardsEl(hand.cards, `${i}-${k}`, seat.hands.length > 1));
      const info = document.createElement('div');
      info.className = 'hand-info';
      info.append(span('total', hand.total > 21 ? `${hand.total} ✗` : String(hand.total)));
      info.append(span('seat-bet', `${hand.bet}${hand.doubled ? ' ×2' : ''}`));
      if (hand.result) info.append(span(`res ${hand.result}`, RESULT_LABEL[hand.result]));
      h.appendChild(info);
      el.appendChild(h);
    });

    if (seat.leaving) el.append(span('seat-sub', 'Se levanta al terminar'));
    return el;
  }

  function statusText(mine) {
    switch (state.phase) {
      case 'waiting': return state.seats.some(Boolean) ? 'Esperando apuestas' : 'Mesa libre, siéntate para jugar';
      case 'betting': return 'Apuestas abiertas · reparto en';
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

    if (state.phase === 'waiting') renderedCounts = new Map();

    // Crupier
    const dealer = $('#bj-dealer-cards');
    dealer.replaceWith(Object.assign(cardsEl(state.dealer.cards, 'dealer'), { id: 'bj-dealer-cards' }));
    $('#bj-dealer-total').textContent = state.dealer.total ?? '';

    // Asientos
    const seats = $('#bj-seats');
    seats.innerHTML = '';
    state.seats.forEach((s, i) => seats.appendChild(seatEl(s, i, mine)));

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
