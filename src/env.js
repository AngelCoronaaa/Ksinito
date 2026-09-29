'use strict';

/**
 * Entero no negativo de una variable de entorno. Si falta se usa `fallback`; si no es
 * válido, también, y se avisa en consola con la etiqueta `label` (p. ej. "ducks").
 */
function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, label = 'config' } = {}) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  console.warn(`[${label}] ${name}=${raw} no es válido (entero entre ${min} y ${max}); se usa ${fallback}`);
  return fallback;
}

module.exports = { intEnv };
