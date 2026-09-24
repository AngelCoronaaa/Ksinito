'use strict';

// Envío de créditos a otro jugador por su ID de 8 cifras.
window.TransferUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => n.toLocaleString('es');
  const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

  let ctx;
  let modal;
  let recipient = null; // { publicId, username, avatar } del ID escrito
  let lookupSeq = 0;
  let sending = false;

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function ago(at) {
    const s = Math.round((at - Date.now()) / 1000);
    if (s > -60) return relative.format(s, 'second');
    if (s > -3600) return relative.format(Math.round(s / 60), 'minute');
    if (s > -86400) return relative.format(Math.round(s / 3600), 'hour');
    return new Date(at).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  const setError = (message) => { $('#transfer-error').textContent = message; };

  function amount() {
    const n = Number($('#transfer-amount').value);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function refreshSubmit() {
    const n = amount();
    const ready = recipient && n > 0 && !sending;
    $('#transfer-submit').disabled = !ready;
    $('#transfer-submit-label').textContent = recipient && n > 0 ? `Enviar ${fmt(n)} a ${recipient.username}` : 'Enviar';
  }

  /** Busca al jugador en cuanto el ID tiene 8 cifras, para confirmar a quién se envía. */
  async function lookup() {
    const input = $('#transfer-to');
    const id = input.value.replace(/\D/g, '').slice(0, 8);
    input.value = id;
    recipient = null;
    setError('');
    $('#transfer-recipient').replaceChildren();
    refreshSubmit();
    if (id.length !== 8) return;
    if (id === ctx.user.publicId) return setError('Ese es tu propio ID.');

    const seq = ++lookupSeq;
    try {
      const { user } = await ctx.api(`/api/users/${id}`);
      if (seq !== lookupSeq) return; // ya se escribió otro ID
      recipient = user;
      const icon = document.createElement('i');
      icon.className = 'bi bi-check-circle-fill tr-check';
      $('#transfer-recipient').replaceChildren(
        ctx.avatar(user.username, user.avatar),
        span('tr-name', user.username),
        span('tr-id', `ID ${user.publicId}`),
        icon
      );
      refreshSubmit();
    } catch (err) {
      if (seq === lookupSeq) setError(err.message);
    }
  }

  async function loadHistory() {
    const list = $('#transfer-history');
    try {
      const { transfers } = await ctx.api('/api/transfers');
      if (!transfers.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Aún no has enviado ni recibido créditos.';
        return list.replaceChildren(empty);
      }
      list.replaceChildren(
        ...transfers.map((t) => {
          const incoming = t.direction === 'in';
          const li = document.createElement('li');
          li.className = incoming ? 'th-in' : 'th-out';
          const icon = document.createElement('span');
          icon.className = 'th-icon';
          icon.innerHTML = `<i class="bi ${incoming ? 'bi-arrow-down-left' : 'bi-arrow-up-right'}"></i>`;
          const text = document.createElement('span');
          text.className = 'th-text';
          text.append(
            span('', `${incoming ? 'De' : 'A'} ${t.other.username}`),
            span('th-sub', `ID ${t.other.publicId} · ${ago(t.at)}`)
          );
          li.append(icon, text, span('th-amount', `${incoming ? '+' : '−'}${fmt(t.amount)}`));
          return li;
        })
      );
    } catch {
      // el historial es informativo: si falla, se deja como estaba
    }
  }

  async function submit(e) {
    e.preventDefault();
    const n = amount();
    if (!recipient || !n || sending) return;
    sending = true;
    refreshSubmit();
    setError('');
    try {
      await ctx.api('/api/transfer', { to: recipient.publicId, amount: n });
      ctx.toast(`Enviaste ${fmt(n)} créditos a ${recipient.username}`, 'success');
      $('#transfer-amount').value = '';
      loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      sending = false;
      refreshSubmit();
    }
  }

  /** Abre el modal; `publicId` rellena el destinatario (p. ej. desde el chat). */
  function open(publicId = '') {
    $('#transfer-to').value = publicId;
    $('#transfer-amount').value = '';
    lookup();
    loadHistory();
    modal.show();
  }

  function onReceived({ amount: n, from }) {
    ctx.celebrate({ amount: n, title: '¡Créditos recibidos!', detail: `De ${from.username} · ID ${from.publicId}` });
    if ($('#transfer-modal').classList.contains('show')) loadHistory();
  }

  function init(appCtx) {
    ctx = appCtx;
    modal = window.bootstrap.Modal.getOrCreateInstance($('#transfer-modal'));
    $('#transfer-open').addEventListener('click', () => open());
    $('#transfer-to').addEventListener('input', lookup);
    $('#transfer-amount').addEventListener('input', refreshSubmit);
    $('#transfer-form').addEventListener('submit', submit);
    document.querySelectorAll('.transfer-quick [data-amount]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.amount === 'all' ? ctx.credits() : Number(btn.dataset.amount);
        $('#transfer-amount').value = value || '';
        refreshSubmit();
      });
    });
    $('#transfer-modal').addEventListener('shown.bs.modal', () => {
      (recipient ? $('#transfer-amount') : $('#transfer-to')).focus();
    });
    ctx.socket.on('transfer:received', onReceived);
  }

  return { init, open };
})();
