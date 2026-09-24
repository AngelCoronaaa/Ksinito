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
| `JWT_SECRET`    | Secreto para firmar los tokens de sesión (mínimo 32 caracteres). Si no se define, se genera uno y se guarda en `DATA_DIR/jwt-secret` |
| `COOKIE_SECURE` | Pon `1` en producción con HTTPS para marcar la cookie como `Secure`  |
| `TRUST_PROXY`   | Pon `1` si está detrás de un proxy (nginx, etc.) para leer la IP real |

## Sesiones (JWT)

- Al registrarte o entrar, el servidor firma un **JWT** (HS256, 7 días) y lo guarda en la
  cookie httpOnly `ksjwt`. Los sockets se autentican con la misma cookie.
- Los tokens no se guardan en la base de datos, así que siguen valiendo tras reiniciar o
  redesplegar siempre que `JWT_SECRET` no cambie. `/api/me` renueva el token si tiene más de un día.
- El token incluye la fecha de creación de la cuenta: si la base se borra y otra persona
  recibe el mismo id, el token viejo deja de valer.

## Despliegue: que no se pierdan las cuentas

Las cuentas y los créditos viven en `DATA_DIR/casino.db`. Si la plataforma borra el disco en
cada despliegue (Render, Railway, Fly… sin volumen), **se pierden todos los usuarios**, con JWT
o sin él. Para evitarlo:

1. Crea un disco/volumen persistente en la plataforma y móntalo, por ejemplo, en `/var/data`.
2. Define `DATA_DIR=/var/data` y un `JWT_SECRET` fijo (p. ej. `openssl rand -base64 48`).
3. Al arrancar, el log muestra `[db] Base de datos en …`: comprueba que apunta al volumen.

## Perfil

- Pulsa tu nombre arriba a la derecha para subir (o arrastrar) una foto de perfil. El navegador
  la recorta en cuadrado y la reduce a 256×256 antes de subirla.
- El servidor solo acepta JPEG, PNG o WebP (lo comprueba por el contenido, no por la extensión),
  de hasta 300 KB y 1024×1024 px. Las fotos se guardan en la tabla `avatars` de la misma base de
  datos, así que se conservan igual que las cuentas (ver "Despliegue").
- Los demás jugadores ven tu foto, tu nombre y tu apuesta en la mesa de blackjack.

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
  apuesta. Las cartas se dan una a una (como en una mesa real) y salen animadas desde
  el zapato; la carta tapada del crupier se gira al descubrirse. Cada jugador tiene 20 s por turno (si no, se planta solo).
- Si cierras la pestaña, conservas el asiento 20 s por si recargas.

## Estructura

```
src/
  server.js     Express + Socket.IO, autenticación de sockets
  auth.js       Registro, login y sesiones JWT (cookie httpOnly)
  avatars.js    Fotos de perfil: validación y almacenamiento
  profile.js    Rutas para subir, quitar y servir la foto
  wallet.js     Único módulo que modifica créditos
  db.js         Esquema SQLite
  roulette.js   Lógica de la ruleta
  blackjack.js  Lógica de la mesa de blackjack
public/         Cliente: Bootstrap 5 + Bootstrap Icons, JS sin frameworks y sin build.
                Bootstrap, iconos, fuentes (Inter, Cinzel) y canvas-confetti se sirven
                desde node_modules en /vendor (mismo origen, sin CDN).
```
