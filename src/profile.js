'use strict';

// Rutas del perfil: subir, quitar y servir la foto de perfil.

const express = require('express');
const auth = require('./auth');
const avatars = require('./avatars');
const { GameError } = require('./errors');

const router = express.Router();

function requireUser(req, res, next) {
  const user = auth.userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  req.user = user;
  next();
}

router.put(
  '/avatar',
  requireUser,
  auth.rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'Has cambiado la foto demasiadas veces. Inténtalo más tarde.' }),
  express.raw({ type: avatars.MIME_TYPES, limit: avatars.MAX_BYTES }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(415).json({ error: 'Sube una imagen JPG, PNG o WebP.' });
    }
    try {
      res.json({ avatar: avatars.saveAvatar(req.user.id, req.body) });
    } catch (err) {
      if (err instanceof GameError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }
);

router.delete('/avatar', requireUser, (req, res) => {
  avatars.removeAvatar(req.user.id);
  res.json({ avatar: null });
});

// Pública: los demás jugadores ven la foto en la mesa. La URL lleva ?v=versión,
// así que se puede cachear para siempre.
router.get('/avatar/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) ? avatars.getAvatar(id) : null;
  if (!row) return res.status(404).end();
  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.type(row.mime).send(Buffer.from(row.data));
});

router.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `La imagen pesa demasiado (máx. ${avatars.MAX_BYTES / 1024} KB).` });
  }
  next(err);
});

module.exports = { router };
