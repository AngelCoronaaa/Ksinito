'use strict';

// Tienda de cosméticos: bordes de perfil por niveles (básico, especial, legendario, mítico).
// El catálogo, los precios y lo que tienes vienen de /api/cosmetics; el dibujo, de FramesUI.
// Se pulsa un borde para verlo en grande con tu foto, y desde ahí se compra o se equipa.
window.CosmeticsUI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const CONFIRM_MS = 3500; // la compra pide un segundo clic en este tiempo

  let ctx;
  let data = null; // { tiers, frames, owned, equipped }
  let selected = null; // id del borde en la vista previa
  let confirming = null; // { id, timer } mientras se espera el segundo clic
  let busy = false;
  let loading = null;

  const fmt = (n) => n.toLocaleString('es');
  const frameById = (id) => data?.frames.find((f) => f.id === id) ?? null;
  const tierName = (tier) => data?.tiers.find((t) => t.id === tier)?.name ?? tier;
  const owns = (id) => data?.owned.includes(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function avatar(frame, extra) {
    return ctx.avatar(ctx.user.username, ctx.user.avatar, extra, frame);
  }

  function cancelConfirm() {
    if (!confirming) return;
    clearTimeout(confirming.timer);
    confirming = null;
  }

  function renderPreview() {
    const frame = frameById(selected);
    $('#cs-stage').replaceChildren(avatar(selected, 'avatar-xl cs-avatar'));
    $('#cs-name').textContent = frame ? frame.name : 'Sin borde';
    const tier = $('#cs-tier');
    tier.className = `cs-tier-label${frame ? ` cs-t-${frame.tier}` : ''}`;
    tier.textContent = frame ? tierName(frame.tier) : 'Elige un borde de la tienda';

    const btn = $('#cs-action');
    btn.className = 'btn cs-action';
    if (!frame) {
      btn.disabled = true;
      btn.classList.add('btn-glass');
      btn.textContent = 'Elige un borde';
    } else if (data.equipped === frame.id) {
      btn.disabled = true;
      btn.classList.add('btn-glass');
      btn.innerHTML = '<i class="bi bi-check2-circle me-1"></i>Equipado';
    } else if (owns(frame.id)) {
      btn.disabled = busy;
      btn.classList.add('btn-gold');
      btn.innerHTML = '<i class="bi bi-person-badge me-1"></i>Equipar';
    } else {
      const sure = confirming?.id === frame.id;
      const short = (ctx.credits() ?? 0) < frame.price;
      btn.disabled = busy || short;
      btn.classList.add(sure ? 'btn-danger' : 'btn-gold');
      btn.innerHTML = sure
        ? `<i class="bi bi-exclamation-circle me-1"></i>Confirmar: ${fmt(frame.price)}`
        : `<i class="bi bi-coin me-1"></i>${short ? 'Te faltan créditos' : 'Comprar'} · ${fmt(frame.price)}`;
    }
    $('#cs-unequip').classList.toggle('hidden', !data.equipped);
    $('#cs-unequip').disabled = busy;
  }

  function cardEl(frame) {
    const card = el('button', 'cs-card');
    card.type = 'button';
    card.dataset.id = frame.id;
    card.classList.toggle('selected', frame.id === selected);
    card.classList.toggle('owned', owns(frame.id));
    card.classList.toggle('equipped', data.equipped === frame.id);
    const stage = el('span', 'cs-card-stage');
    stage.append(avatar(frame.id, 'cs-mini'));
    const status =
      data.equipped === frame.id
        ? el('span', 'cs-status on', 'Equipado')
        : owns(frame.id)
          ? el('span', 'cs-status mine', 'Tuyo')
          : el('span', 'cs-status price', fmt(frame.price));
    card.append(stage, el('span', 'cs-card-name', frame.name), status);
    card.setAttribute('aria-label', `${frame.name}, ${tierName(frame.tier)}`);
    card.addEventListener('click', () => {
      if (selected === frame.id) return;
      selected = frame.id;
      cancelConfirm();
      render();
    });
    return card;
  }

  function renderShop() {
    $('#cs-shop').replaceChildren(
      ...data.tiers.map((tier) => {
        const group = el('section', `cs-group cs-t-${tier.id}`);
        const head = el('header', 'cs-group-head');
        const price = el('span', 'cs-group-price');
        price.innerHTML = '<i class="bi bi-coin"></i>';
        price.append(` ${fmt(tier.price)}`);
        head.append(el('h3', 'cs-group-name', tier.name), price);
        const grid = el('div', 'cs-grid');
        grid.append(...data.frames.filter((f) => f.tier === tier.id).map(cardEl));
        group.append(head, grid);
        return group;
      })
    );
  }

  function render() {
    if (!data) return;
    renderPreview();
    renderShop();
  }

  async function load() {
    loading ??= ctx
      .api('/api/cosmetics')
      .then((res) => {
        data = res;
        selected ??= data.equipped ?? data.frames[0]?.id ?? null;
        render();
      })
      .catch((err) => {
        $('#cs-shop').replaceChildren(el('p', 'hint', err.message));
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  async function act() {
    const frame = frameById(selected);
    if (!frame || busy) return;
    if (!owns(frame.id) && confirming?.id !== frame.id) {
      // Primer clic: pide confirmación (cuesta miles de créditos).
      cancelConfirm();
      confirming = { id: frame.id, timer: setTimeout(() => { confirming = null; renderPreview(); }, CONFIRM_MS) };
      renderPreview();
      return;
    }
    cancelConfirm();
    busy = true;
    renderPreview();
    try {
      if (!owns(frame.id)) {
        const res = await ctx.api('/api/cosmetics/buy', { id: frame.id });
        data.owned = res.owned;
        ctx.celebrate({ badge: avatar(frame.id, 'cs-celebrate'), title: '¡Nuevo borde!', detail: `${frame.name} · ${tierName(frame.tier)}`, big: frame.tier === 'mitico' });
      }
      // Recién comprado o ya tuyo: se equipa directamente.
      const res = await ctx.api('/api/cosmetics/equip', { id: frame.id });
      data.equipped = res.equipped;
    } catch (err) {
      ctx.toast(err.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  async function unequip() {
    if (busy) return;
    busy = true;
    try {
      const res = await ctx.api('/api/cosmetics/equip', { id: null });
      data.equipped = res.equipped;
    } catch (err) {
      ctx.toast(err.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  /** Al cambiar la foto o el borde (también desde otra pestaña): redibuja con lo nuevo. */
  function refresh() {
    if (!ctx || !data) return;
    data.equipped = ctx.user.frame ?? null;
    render();
  }

  function setActive(active) {
    if (active) load();
    else cancelConfirm();
  }

  function init(appCtx) {
    ctx = appCtx;
    $('#cs-action').addEventListener('click', act);
    $('#cs-unequip').addEventListener('click', unequip);
    // El botón de comprar depende del saldo.
    ctx.socket.on('balance', () => {
      if (data && !$('#cosmetics').classList.contains('hidden')) renderPreview();
    });
  }

  return { init, setActive, refresh };
})();
