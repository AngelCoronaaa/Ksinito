'use strict';

/** Error que se puede mostrar al jugador tal cual. */
class GameError extends Error {}

function assertInt(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new GameError(`${label} debe ser un número entero entre ${min} y ${max}`);
  }
  return value;
}

module.exports = { GameError, assertInt };
