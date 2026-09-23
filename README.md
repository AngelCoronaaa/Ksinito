# Ksinito

Casino online con **Ruleta** y **Blackjack** multijugador en tiempo real, con créditos ficticios.

## Cómo arrancarlo

Requiere Node.js 22.13 o superior (usa el SQLite que trae Node, sin dependencias nativas).

```bash
npm install
npm start          # http://localhost:3000
```

Variables de entorno opcionales:

| Variable        | Uso                                                                  |
|-----------------|----------------------------------------------------------------------|
| `PORT`          | Puerto HTTP (por defecto `3000`)                                     |
| `DATA_DIR`      | Carpeta de la base de datos (por defecto `./data`)                   |
| `COOKIE_SECURE` | Pon `1` en producción con HTTPS para marcar la cookie como `Secure`  |
| `TRUST_PROXY`   | Pon `1` si está detrás de un proxy (nginx, etc.) para leer la IP real |

## Créditos

- Cada cuenta recibe **100 créditos una sola vez**, al iniciar sesión por primera vez.
  La columna `welcome_bonus_granted` evita que se vuelvan a dar.
- Los créditos se guardan en SQLite (`data/casino.db`, tabla `users`) y cada movimiento
  queda registrado en la tabla `ledger` (apuestas, premios, reembolsos, bono).
- **No se pueden dar créditos desde la consola del navegador**: el cliente solo envía
  intenciones ("apuesto 10 al rojo", "pido carta"). El servidor valida cada apuesta
  (entero, límites, fase del juego, turno, saldo), baraja, reparte, gira la ruleta con
  `crypto.randomInt` y calcula los pagos. No existe ningún endpoint ni evento que sume
  créditos. La carta tapada del crupier nunca se envía al cliente hasta que se revela.
- Para dificultar el farmeo de cuentas hay un límite de 5 registros por hora por IP.

## Ruleta

- Ruleta europea (un cero), con rondas compartidas por todos: 20 s de apuestas,
  7 s de giro y 5 s mostrando el resultado.
- Pleno 35:1 · Docena y columna 2:1 · Rojo/Negro, Par/Impar, 1-18/19-36 1:1.
- Se guardan en base de datos los **últimos 30 giros** (tabla `roulette_spins`).

## Blackjack

- Una mesa de **máximo 6 jugadores**; el resto puede mirar hasta que se libere un asiento.
- 6 barajas, el crupier se planta en 17, blackjack paga 3:2, doblar con dos cartas y
  dividir una vez.
- La mano se reparte cuando todos los sentados apostaron o 15 s después de la primera
  apuesta. Cada jugador tiene 20 s por turno (si no, se planta solo).
- Si cierras la pestaña, conservas el asiento 20 s por si recargas.

## Estructura

```
src/
  server.js     Express + Socket.IO, autenticación de sockets
  auth.js       Registro, login, sesiones (cookie httpOnly)
  wallet.js     Único módulo que modifica créditos
  db.js         Esquema SQLite
  roulette.js   Lógica de la ruleta
  blackjack.js  Lógica de la mesa de blackjack
public/         Cliente (HTML, CSS y JS sin frameworks)
```
