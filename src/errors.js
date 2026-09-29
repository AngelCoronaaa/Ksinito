'use strict';

/**
 * Error que se puede mostrar al jugador tal cual. `extra` (opcional) son datos que acompañan
 * al mensaje en la respuesta del socket (p. ej. `retryAfter`).
 */
class GameError extends Error {
  constructor(message, extra = undefined) {
    super(message);
    if (extra) this.extra = extra;
  }
}

function assertInt(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new GameError(`${label} debe ser un número entero entre ${min} y ${max}`);
  }
  return value;
}

module.exports = { GameError, assertInt };
