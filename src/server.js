'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const auth = require('./auth');
const wallet = require('./wallet');
const { GameError } = require('./errors');
const { RouletteGame } = require('./roulette');
const { BlackjackTable } = require('./blackjack');

const PORT = Number(process.env.PORT) || 3000;
const LEAVE_GRACE_MS = 20_000; // tiempo para recargar la página sin perder el asiento
const EVENTS_PER_SECOND = 15;

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
const blackjack = new BlackjackTable(io);

// Cada cambio de saldo se envía a todas las pestañas abiertas del usuario.
wallet.events.on('balance', (userId, credits) => io.to(`user:${userId}`).emit('balance', { credits }));

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

  socket.join([`user:${user.id}`, roulette.room, blackjack.room]);
  socket.emit('balance', { credits: wallet.getBalance(user.id) });
  socket.emit('roulette:state', roulette.publicState());
  socket.emit('roulette:bets', roulette.userBets(user.id));
  socket.emit('bj:state', blackjack.publicState());

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
  on('bj:sit', (p) => blackjack.sit(user, p.seat));
  on('bj:leave', () => blackjack.leave(user.id));
  on('bj:bet', (p) => blackjack.placeBet(user, p.amount));
  on('bj:action', (p) => blackjack.act(user, p.action));

  socket.on('disconnect', () => {
    const remaining = (connections.get(user.id) ?? 1) - 1;
    if (remaining > 0) return connections.set(user.id, remaining);
    connections.delete(user.id);
    leaveTimers.set(
      user.id,
      setTimeout(() => {
        leaveTimers.delete(user.id);
        if (!connections.has(user.id)) blackjack.leave(user.id);
      }, LEAVE_GRACE_MS)
    );
  });
});

server.listen(PORT, () => console.log(`Ksinito escuchando en http://localhost:${PORT}`));
