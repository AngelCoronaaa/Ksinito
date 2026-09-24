'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const auth = require('./auth');
const profile = require('./profile');
const avatars = require('./avatars');
const wallet = require('./wallet');
const { GameError, assertInt } = require('./errors');
const { RouletteGame } = require('./roulette');
const { BlackjackTable } = require('./blackjack');

const PORT = Number(process.env.PORT) || 3000;
const LEAVE_GRACE_MS = 20_000; // tiempo para recargar la página sin perder el asiento
const EVENTS_PER_SECOND = 15;
const BLACKJACK_TABLES = 5;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use('/api', auth.router);
app.use('/api', profile.router);

// Librerías del cliente servidas desde node_modules (mismo origen, sin CDN).
const vendor = (pkg, dir = '') =>
  express.static(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), dir), { maxAge: '7d' });
app.use('/vendor/bootstrap', vendor('bootstrap', 'dist'));
app.use('/vendor/bootstrap-icons', vendor('bootstrap-icons', 'font'));
app.use('/vendor/confetti', vendor('canvas-confetti', 'dist'));
app.use('/vendor/fonts/inter', vendor('@fontsource-variable/inter'));
app.use('/vendor/fonts/cinzel', vendor('@fontsource/cinzel'));

app.use(express.static(path.join(__dirname, '..', 'public')));

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

const roulette = new RouletteGame(io);

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

// Cada cambio de saldo se envía a todas las pestañas abiertas del usuario.
wallet.events.on('balance', (userId, credits) => io.to(`user:${userId}`).emit('balance', { credits }));

// Al cambiar la foto se avisa a sus pestañas y, si está sentado, a toda la mesa.
avatars.events.on('change', (userId, avatar) => {
  io.to(`user:${userId}`).emit('profile', { avatar });
  tableOf(userId)?.broadcast();
});

io.use((socket, next) => {
  const user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = { id: user.id, username: user.username };
  next();
});

const connections = new Map(); // userId -> nº de sockets abiertos
const leaveTimers = new Map();

io.on('connection', (socket) => {
  const user = socket.data.user;
  connections.set(user.id, (connections.get(user.id) ?? 0) + 1);
  clearTimeout(leaveTimers.get(user.id));
  leaveTimers.delete(user.id);

  // Las salas de blackjack se eligen con bj:watch.
  socket.join([`user:${user.id}`, roulette.room]);
  socket.emit('balance', { credits: wallet.getBalance(user.id) });
  socket.emit('roulette:state', roulette.publicState());
  socket.emit('roulette:bets', roulette.userBets(user.id));
  socket.emit('bj:lobby', lobbyState());

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
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, error: 'Vas demasiado rápido' });
      try {
        handler(payload && typeof payload === 'object' ? payload : {});
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
    for (const other of tables.values()) if (other !== table) socket.leave(other.room);
    socket.join(table.room);
  };
  on('bj:watch', (p) => {
    const table = getTable(p.table);
    watch(table);
    socket.emit('bj:state', table.publicState());
  });
  on('bj:sit', (p) => {
    const table = getTable(p.table);
    const current = tableOf(user.id);
    if (current && current !== table) throw new GameError(`Ya estás sentado en la ${current.name}`);
    watch(table); // antes de sentarse, para recibir el estado que se envía al hacerlo
    table.sit(user, p.seat);
  });
  on('bj:leave', () => tableOf(user.id)?.leave(user.id));
  on('bj:bet', (p) => requireTable(user.id).placeBet(user, p.amount));
  on('bj:action', (p) => requireTable(user.id).act(user, p.action));

  socket.on('disconnect', () => {
    const remaining = (connections.get(user.id) ?? 1) - 1;
    if (remaining > 0) return connections.set(user.id, remaining);
    connections.delete(user.id);
    leaveTimers.set(
      user.id,
      setTimeout(() => {
        leaveTimers.delete(user.id);
        if (!connections.has(user.id)) tableOf(user.id)?.leave(user.id);
      }, LEAVE_GRACE_MS)
    );
  });
});

server.listen(PORT, () => console.log(`Ksinito escuchando en http://localhost:${PORT}`));
