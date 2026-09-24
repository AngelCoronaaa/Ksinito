'use strict';

/**
 * Ejecuta operaciones asíncronas de una en una, en orden de llegada.
 *
 * Con MySQL cada cobro tarda unos milisegundos. Sin esta cola, dos apuestas del
 * mismo jugador podrían comprobar los límites a la vez y superarlos, o el temporizador
 * de la mesa podría cambiar de fase mientras una apuesta espera a la base de datos.
 * Cada juego tiene su cola y todo lo que cambia su estado pasa por ella.
 */
class SerialQueue {
  constructor(label) {
    this.label = label;
    this.tail = Promise.resolve();
  }

  /** Encola fn y devuelve su resultado (o su error) a quien la llamó. */
  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => {}); // un error no detiene la cola
    return result;
  }

  /** Para temporizadores: nadie espera el resultado, así que los errores solo se registran. */
  fire(fn) {
    this.run(fn).catch((err) => console.error(`[${this.label}]`, err));
  }
}

module.exports = { SerialQueue };
