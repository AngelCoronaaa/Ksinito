'use strict';

// Chat flotante. Muestra el canal del juego que se está viendo: "roulette" o
// la mesa de blackjack que se mira ("bj:1", "bj:2"…).
window.ChatUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const MAX_KEEP = 100;

  let ctx;
  let channel = 'roulette';
  let label = 'Ruleta';
  let open = false;
  let unread = 0;
  const stores = new Map(); // canal -> mensajes

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  const timeLabel = (at) => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  function messageEl(m) {
    const mine = m.userId === ctx.user.id;
    const el = document.createElement('div');
    el.className = mine ? 'chat-msg mine' : 'chat-msg';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    if (mine) {
      meta.append(span('chat-name', 'Tú'));
    } else {
      // Pulsar el nombre abre el envío de créditos con su ID ya puesto.
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'chat-name';
      name.textContent = m.username;
      name.title = `ID ${m.publicId} · Enviar créditos`;
      name.addEventListener('click', () => ctx.transfer.open(m.publicId));
      meta.append(name);
    }
    meta.append(span('chat-time', timeLabel(m.at)));

    const text = document.createElement('p');
    text.className = 'chat-text';
    text.textContent = m.text; // siempre como texto, nunca como HTML

    const body = document.createElement('div');
    body.className = 'chat-body';
    body.append(meta, text);
    el.append(ctx.avatar(m.username, m.avatar, 'chat-avatar'), body);
    return el;
  }

  function scrollToEnd() {
    const list = $('#chat-messages');
    list.scrollTop = list.scrollHeight;
  }

  function render() {
    $('#chat-channel').textContent = label;
    const messages = stores.get(channel) ?? [];
    const list = $('#chat-messages');
    if (!messages.length) list.replaceChildren(span('chat-empty', 'Nadie ha escrito todavía. ¡Saluda!'));
    else list.replaceChildren(...messages.map(messageEl));
    scrollToEnd();
  }

  function setUnread(n) {
    unread = n;
    const badge = $('#chat-unread');
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('hidden', n === 0);
    $('#chat-toggle').setAttribute('aria-label', n ? `Abrir chat (${n} sin leer)` : 'Abrir chat');
  }

  function append(m) {
    const messages = stores.get(m.channel) ?? [];
    messages.push(m);
    if (messages.length > MAX_KEEP) messages.shift();
    stores.set(m.channel, messages);
    if (m.channel !== channel) return;

    const list = $('#chat-messages');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.querySelector('.chat-empty')?.remove();
    const el = messageEl(m);
    if (!ctx.reducedMotion.matches) el.classList.add('enter');
    list.appendChild(el);
    if (nearBottom || m.userId === ctx.user.id) scrollToEnd();

    if (!open && m.userId !== ctx.user.id) {
      setUnread(unread + 1);
      const fab = $('#chat-toggle');
      fab.classList.remove('ping');
      void fab.offsetWidth;
      fab.classList.add('ping');
    }
  }

  /** Cambia el canal visible (al cambiar de juego o de mesa). */
  function setChannel(newChannel, newLabel) {
    if (newChannel === channel) return;
    channel = newChannel;
    label = newLabel;
    setUnread(0);
    render();
  }

  function toggle(force) {
    open = force ?? !open;
    $('#chat-panel').classList.toggle('hidden', !open);
    $('#chat-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      setUnread(0);
      scrollToEnd();
      $('#chat-input').focus();
    }
  }

  async function send(e) {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await ctx.emit('chat:send', { channel, text });
    if (!res.ok) {
      ctx.toast(res.error, 'error');
      if (!input.value) input.value = text; // no se pierde lo escrito
    }
  }

  function init(appCtx) {
    ctx = appCtx;
    $('#chat-toggle').addEventListener('click', () => toggle());
    $('#chat-close').addEventListener('click', () => toggle(false));
    $('#chat-form').addEventListener('submit', send);
    $('#chat-panel').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        toggle(false);
        $('#chat-toggle').focus();
      }
    });
    ctx.socket.on('chat:history', ({ channel: ch, messages }) => {
      stores.set(ch, messages);
      if (ch === channel) render();
    });
    ctx.socket.on('chat:message', append);
    render();
  }

  return { init, setChannel };
})();
