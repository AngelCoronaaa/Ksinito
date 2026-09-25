'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const auth = require('./auth');
const profile = require('./profile');
const transfers = require('./transfers');
const chat = require('./chat');
const db = require('./db');
const { SerialQueue } = require('./queue');
const avatars = require('./avatars');
const wallet = require('./wallet');
const { GameError, assertInt } = require('./errors');
const { RouletteGame } = require('./roulette');
const { BlackjackTable } = require('./blackjack');

const PORT = Number(process.env.PORT) || 3000;
const LEAVE_GRACE_MS = 20_000; // tiempo para recargar la página sin perder el asiento
const EVENTS_PER_SECOND = 15;
const BLACKJACK_TABLES = 5;
const RTC_SIGNALS_PER_SECOND = 60; // candidatos ICE de varias cámaras a la vez

// Servidores STUN/TURN para las cámaras (WebRTC). Con solo STUN, algunas redes (datos
// móviles, redes corporativas) no conectan; para ellas hace falta un TURN en RTC_ICE_SERVERS.
const ICE_SERVERS = (() => {
  try {
    if (process.env.RTC_ICE_SERVERS) return JSON.parse(process.env.RTC_ICE_SERVERS);
  } catch {
    console.warn('[rtc] RTC_ICE_SERVERS no es JSON válido; se usa el STUN por defecto');
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
})();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    // La cámara solo la pide esta web (mesa de blackjack); micrófono y ubicación no se usan.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
// Permite comprobar desde fuera que la app está viva y llega a MySQL.
app.get('/api/health', async (req, res) => {
  const database = (await db.ping()) ? 'ok' : 'unreachable';
  res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', database: `mysql ${database}` });
});
app.use('/api', auth.router);
app.use('/api', profile.router);
app.use('/api', transfers.router);

// Librerías del cliente servidas desde node_modules (mismo origen, sin CDN).
const vendor = (pkg, dir = '') =>
  express.static(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), dir), { maxAge: '7d' });
app.use('/vendor/bootstrap', vendor('bootstrap', 'dist'));
app.use('/vendor/bootstrap-icons', vendor('bootstrap-icons', 'font'));
app.use('/vendor/confetti', vendor('canvas-confetti', 'dist'));
app.use('/vendor/fonts/inter', vendor('@fontsource-variable/inter'));
app.use('/vendor/fonts/cinzel', vendor('@fontsource/cinzel'));

// Cada versión del código cambia la URL de CSS/JS (?v=huella del contenido). Si no, el
// navegador (Cloudflare le deja cachearlos 4 h) usa JS viejo con el HTML nuevo tras un deploy.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const assetsHash = crypto.createHash('sha256').update(JSON.stringify(require('../package.json').dependencies));
for (const file of fs.readdirSync(PUBLIC_DIR, { recursive: true }).sort()) {
  const full = path.join(PUBLIC_DIR, file);
  if (fs.statSync(full).isFile()) assetsHash.update(file).update(fs.readFileSync(full));
}
const ASSETS_VERSION = assetsHash.digest('hex').slice(0, 12);
const indexHtml = fs
  .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="(\/(?:css|js|vendor)\/[^"?]+)"/g, `$1="$2?v=${ASSETS_VERSION}"`);
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml);
});

app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  // Rechaza conexiones WebSocket desde otros dominios.
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try {
      sameOrigin ||= new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    callback(null, sameOrigin);
  },
});

let roulette = null; // se crea en main(), tras conectar a MySQL

// Resumen de todas las mesas (quién está sentado y en qué fase), agrupado para
// no enviarlo en cada carta repartida.
let lobbyTimer = null;
let lastLobby = '';
const lobbyState = () => [...tables.values()].map((t) => t.summary());
function scheduleLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    const lobby = lobbyState();
    const json = JSON.stringify(lobby);
    if (json === lastLobby) return;
    lastLobby = json;
    io.emit('bj:lobby', lobby);
  }, 150);
}

const tables = new Map();
for (let id = 1; id <= BLACKJACK_TABLES; id++) tables.set(id, new BlackjackTable(io, id, { onChange: scheduleLobby }));

function getTable(id) {
  return tables.get(assertInt(id, 1, BLACKJACK_TABLES, 'La mesa'));
}

/** Mesa en la que está sentado el usuario (solo puede estar en una). */
function tableOf(userId) {
  for (const table of tables.values()) if (table.seatIndexOf(userId) !== -1) return table;
  return null;
}

function requireTable(userId) {
  const table = tableOf(userId);
  if (!table) throw new GameError('No estás sentado en ninguna mesa');
  return table;
}

/**
 * Mesa por la que dos sockets pueden intercambiar señales WebRTC: uno emite cámara en
 * ella y el otro la está mirando. Sin esto, cualquiera podría escribir a cualquier socket.
 */
function rtcTableFor(a, b) {
  for (const table of tables.values()) {
    const cams = table.cameraSockets();
    if ((cams.includes(a.id) && b.rooms.has(table.room)) || (cams.includes(b.id) && a.rooms.has(table.room))) return table;
  }
  return null;
}

/** Solo se reenvían los campos que usa el cliente, con tamaños acotados. */
function cleanSignal(msg) {
  const kinds = ['want', 'offer', 'answer', 'candidate', 'bye'];
  if (!msg || typeof msg !== 'object' || !kinds.includes(msg.kind) || typeof msg.to !== 'string') return null;
  const out = { kind: msg.kind };
  if (msg.kind === 'offer' || msg.kind === 'answer') {
    if (typeof msg.sdp !== 'string' || msg.sdp.length > 20_000) return null;
    out.sdp = msg.sdp;
  }
  if (msg.kind === 'candidate') {
    const c = msg.candidate;
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > 1_000) return null;
    out.candidate = {
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
      sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
    };
  }
  return out;
}

/** Avisa a quienes emiten cámara de que este socket ya no mira (cierran su conexión con él). */
function rtcGone(socketId) {
  for (const table of tables.values()) {
    for (const cam of table.cameraSockets()) if (cam !== socketId) io.to(cam).emit('rtc:gone', { peer: socketId });
  }
}

// Cada cambio de saldo se envía a todas las pestañas abiertas del usuario.
wallet.events.on('balance', (userId, credits) => io.to(`user:${userId}`).emit('balance', { credits }));

// Al cambiar la foto se avisa a sus pestañas y, si está sentado, a toda la mesa.
avatars.events.on('change', (userId, avatar) => {
  io.to(`user:${userId}`).emit('profile', { avatar });
  tableOf(userId)?.broadcast();
});

// El que recibe créditos se entera al momento, esté en la pestaña que esté.
transfers.events.on('sent', ({ toUserId, amount, from }) => {
  io.to(`user:${toUserId}`).emit('transfer:received', { amount, from });
});

io.use(async (socket, next) => {
  try {
    const user = await auth.userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = { id: user.id, publicId: user.publicId, username: user.username };
    next();
  } catch (err) {
    console.error('[socket] No se pudo autenticar', err);
    next(new Error('unavailable'));
  }
});

// Sentarse se comprueba contra todas las mesas; esta cola evita que dos pestañas
// del mismo jugador lo sienten en dos mesas a la vez.
const seating = new SerialQueue('seating');

const connections = new Map(); // userId -> nº de sockets abiertos
const leaveTimers = new Map();

io.on('connection', (socket) => {
  const user = socket.data.user;
  connections.set(user.id, (connections.get(user.id) ?? 0) + 1);
  clearTimeout(leaveTimers.get(user.id));
  leaveTimers.delete(user.id);

  // Las salas de blackjack se eligen con bj:watch.
  socket.join([`user:${user.id}`, roulette.room]);
  socket.emit('roulette:state', roulette.publicState());
  socket.emit('roulette:bets', roulette.userBets(user.id));
  socket.emit('bj:lobby', lobbyState());
  socket.emit('rtc:config', { iceServers: ICE_SERVERS });
  // Lo que viene de MySQL llega un poco después; los eventos se registran antes (abajo)
  // para no perder nada de lo que el cliente envíe nada más conectar.
  (async () => {
    socket.emit('balance', { credits: await wallet.getBalance(user.id) });
    socket.emit('chat:history', { channel: roulette.room, messages: await chat.history(roulette.room) });
  })().catch((err) => console.error('[socket] Estado inicial', err));

  // Limitador simple por socket para evitar spam de eventos.
  let tokens = EVENTS_PER_SECOND;
  let last = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(EVENTS_PER_SECOND, tokens + ((now - last) / 1000) * EVENTS_PER_SECOND);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const on = (event, handler) => {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, error: 'Vas demasiado rápido' });
      try {
        await handler(payload && typeof payload === 'object' ? payload : {});
        reply({ ok: true });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(`[${event}]`, err);
        reply({ ok: false, error: err instanceof GameError ? err.message : 'Error interno' });
      }
    });
  };

  on('roulette:bet', (p) => roulette.placeBet(user, p));
  on('roulette:clear', () => roulette.clearBets(user));
  // Mirar una mesa: deja la sala de la anterior y recibe el estado de la nueva.
  const watch = (table) => {
    if (!socket.rooms.has(table.room)) rtcGone(socket.id); // deja de ver las cámaras de la mesa anterior
    for (const other of tables.values()) if (other !== table) socket.leave(other.room);
    socket.join(table.room);
  };
  on('bj:watch', async (p) => {
    const table = getTable(p.table);
    watch(table);
    socket.emit('bj:state', table.publicState());
    socket.emit('chat:history', { channel: table.room, messages: await chat.history(table.room) });
  });
  on('bj:sit', (p) =>
    seating.run(() => {
      const table = getTable(p.table);
      const current = tableOf(user.id);
      if (current && current !== table) throw new GameError(`Ya estás sentado en la ${current.name}`);
      watch(table); // antes de sentarse, para recibir el estado que se envía al hacerlo
      return table.sit(user, p.seat);
    })
  );
  on('bj:leave', () => tableOf(user.id)?.leave(user.id));
  // Cámara del jugador sentado (la emite este socket; solo vídeo, sin audio).
  on('bj:camera', (p) => requireTable(user.id).setCamera(user.id, p.on === true ? socket.id : null));

  // Señalización WebRTC: se reenvía sin pasar por on() para no gastar su límite ni responder.
  let rtcTokens = RTC_SIGNALS_PER_SECOND;
  let rtcLast = Date.now();
  socket.on('rtc:signal', (msg) => {
    const now = Date.now();
    rtcTokens = Math.min(RTC_SIGNALS_PER_SECOND, rtcTokens + ((now - rtcLast) / 1000) * RTC_SIGNALS_PER_SECOND);
    rtcLast = now;
    if (rtcTokens < 1) return;
    rtcTokens -= 1;
    const signal = cleanSignal(msg);
    const target = signal && io.sockets.sockets.get(msg.to);
    if (!target || target === socket || !rtcTableFor(socket, target)) return;
    target.emit('rtc:signal', { ...signal, from: socket.id, fromUser: user.id });
  });

  // Solo se escribe en la ruleta o en la mesa que se está mirando (su sala).
  on('chat:send', async (p) => {
    const channel = p.channel;
    const allowed = channel === roulette.room || [...tables.values()].some((t) => t.room === channel && socket.rooms.has(channel));
    if (!allowed) throw new GameError('Canal de chat no válido');
    io.to(channel).emit('chat:message', await chat.post(user, channel, p.text));
  });
  on('bj:bet', (p) => requireTable(user.id).placeBet(user, p.amount));
  on('bj:action', (p) => requireTable(user.id).act(user, p.action));

  socket.on('disconnect', () => {
    // Su cámara (si la emitía) se apaga ya; el asiento se conserva unos segundos.
    for (const table of tables.values()) {
      table.clearCamera(socket.id).catch((err) => console.error('[blackjack] Al apagar la cámara', err));
    }
    rtcGone(socket.id);
    const remaining = (connections.get(user.id) ?? 1) - 1;
    if (remaining > 0) return connections.set(user.id, remaining);
    connections.delete(user.id);
    leaveTimers.set(
      user.id,
      setTimeout(() => {
        leaveTimers.delete(user.id);
        if (!connections.has(user.id)) {
          tableOf(user.id)?.leave(user.id).catch((err) => console.error('[blackjack] Al levantar al jugador', err));
        }
      }, LEAVE_GRACE_MS)
    );
  });
});

async function main() {
  await db.init(); // conecta y crea las tablas de db/schema.sql si faltan
  await auth.init();
  await avatars.init();
  roulette = await RouletteGame.create(io);
  server.listen(PORT, () => console.log(`Ksinito escuchando en http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('[inicio] No se pudo arrancar Ksinito:', err.message);
  process.exit(1);
});
