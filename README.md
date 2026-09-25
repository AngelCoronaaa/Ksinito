# Ksinito

Casino online con **Ruleta** y **Blackjack** multijugador en tiempo real, con créditos ficticios.

## Base de datos: MySQL

Todo (cuentas, créditos, registro de movimientos, fotos, chat, transferencias, historial de la
ruleta y el secreto de las sesiones) se guarda en **MySQL 8.0+** o un servicio compatible.
El esquema está en [`db/schema.sql`](db/schema.sql): la app lo aplica sola al arrancar (todas
las sentencias son `CREATE TABLE IF NOT EXISTS`), y también puedes pegarlo en la consola SQL de
tu proveedor antes del primer deploy. No usa claves foráneas, así que funciona también en
PlanetScale.

## Cómo arrancarlo

Requiere Node.js 22.9 o superior y un MySQL al que conectarse.

```bash
npm install
cp .env.example .env   # pon aquí tu DATABASE_URL
npm run dev            # http://localhost:3000 (npm start en producción)
```

| Variable             | Uso                                                                              |
|----------------------|----------------------------------------------------------------------------------|
| `DATABASE_URL`       | `mysql://usuario:contraseña@host:3306/base`. Alternativa: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` |
| `DATABASE_SSL`       | `1` si tu proveedor exige conexión cifrada (TiDB Cloud, PlanetScale, Aiven…)       |
| `DATABASE_POOL_SIZE` | Conexiones simultáneas a MySQL (por defecto `10`)                                 |
| `JWT_SECRET`         | Secreto de las sesiones (32+ caracteres). Si no se define, se genera uno y se guarda en la tabla `settings` |
| `PORT`               | Puerto HTTP (por defecto `3000`)                                                  |
| `COOKIE_SECURE`      | `1` en producción con HTTPS para marcar la cookie como `Secure`                    |
| `ACCOUNTS_PER_DEVICE` | Cuentas que se pueden crear desde un mismo navegador (por defecto `2`; `0` = sin límite) |
| `ACCOUNTS_PER_IP`    | Cuentas nuevas por IP en la ventana de abajo (por defecto `3`; `0` = sin límite)   |
| `ACCOUNTS_IP_WINDOW_HOURS` | Ventana del límite por IP, en horas (por defecto `24`; `0` = para siempre)  |
| `CLIENT_IP_HEADER`   | Cabecera con la IP real del jugador (por defecto `cf-connecting-ip`, de Cloudflare). Vacía si no usas Cloudflare, porque se podría falsear |
| `RTC_ICE_SERVERS`    | Servidores STUN/TURN para las cámaras, en JSON (por defecto el STUN público de Google). Ver "Cámaras" |
| `TRUST_PROXY`        | Si está detrás de un proxy (nginx, Traefik…) para leer la IP real                 |

Al arrancar, la app espera hasta ~1 minuto a que MySQL responda. `GET /api/health` devuelve
`{"ok":true,"database":"mysql ok"}` si llega a la base.

## Despliegue

- **Base de datos:** crea un MySQL gestionado (TiDB Cloud Serverless, Aiven, PlanetScale,
  Railway…) o un recurso MySQL en Coolify/Dokploy. Opcionalmente pega `db/schema.sql` en su
  consola. Copia la URL de conexión en `DATABASE_URL` (y `DATABASE_SSL=1` si lo pide).
- **App:** necesita un servidor Node encendido todo el tiempo, porque las partidas corren en
  memoria con temporizadores y los jugadores se conectan por WebSocket (Socket.IO). Sirve un
  VPS con Coolify/Dokploy (hay un `Dockerfile`), Railway, Render o Fly.io. **Vercel y
  Netlify no sirven para la app**: sus funciones se apagan tras cada petición y no mantienen
  WebSockets. Sí sirven para alojar la base de datos (por ejemplo, un MySQL gestionado desde su
  marketplace).
- Como los datos están en MySQL y no dentro del contenedor, **redesplegar la app ya no borra
  las cuentas**.

## Sesiones (JWT)

- Al registrarte o entrar, el servidor firma un **JWT** (HS256, 7 días) y lo guarda en la
  cookie httpOnly `ksjwt`. Los sockets se autentican con la misma cookie.
- Los tokens no se guardan en la base de datos, así que siguen valiendo tras reiniciar o
  redesplegar mientras el secreto no cambie. `/api/me` renueva el token si tiene más de un día.
- El token incluye la fecha de creación de la cuenta: si la base se vacía y otra persona
  recibe el mismo id, el token viejo deja de valer.

## Perfil

- Pulsa tu nombre arriba a la derecha para subir (o arrastrar) una foto de perfil. El navegador
  la recorta en cuadrado y la reduce a 256×256 antes de subirla.
- El servidor solo acepta JPEG, PNG o WebP (lo comprueba por el contenido, no por la extensión),
  de hasta 300 KB y 1024×1024 px. Las fotos se guardan en la tabla `avatars` de MySQL.
- Los demás jugadores ven tu foto, tu nombre y tu apuesta en la mesa de blackjack.

## ID de jugador, transferencias y chat

- Cada cuenta tiene un **ID de 8 cifras** (aparece en tu perfil y en *Enviar créditos*).
- Con el botón de enviar (arriba, junto a tus créditos) mandas créditos a otro jugador con su
  ID y la cantidad. Antes de enviar se muestra su nombre y foto para confirmar. El envío es
  atómico: o se mueven los créditos de los dos, o no cambia nada. El que recibe ve un aviso al
  momento. Pulsar un nombre en el chat abre el envío con su ID ya puesto.
- El chat (botón flotante abajo a la derecha) tiene un canal para la ruleta y otro por cada
  mesa de blackjack. Se guardan los últimos 200 mensajes por canal.

## Créditos

- Cada cuenta recibe **100 créditos una sola vez**, al iniciar sesión por primera vez.
  La columna `welcome_bonus_granted` evita que se vuelvan a dar.
- Los créditos se guardan en MySQL (tabla `users`) y cada movimiento queda registrado en la
  tabla `ledger` (apuestas, premios, reembolsos, bono, envíos).
- **No se pueden dar créditos desde la consola del navegador**: el cliente solo envía
  intenciones ("apuesto 10 al rojo", "pido carta"). El servidor valida cada apuesta
  (entero, límites, fase del juego, turno, saldo), baraja, reparte, gira la ruleta con
  `crypto.randomInt` y calcula los pagos. No existe ningún endpoint ni evento que sume
  créditos. La carta tapada del crupier nunca se envía al cliente hasta que se revela.

## Ruleta

- Ruleta europea (un cero), con rondas compartidas por todos: 20 s de apuestas,
  7 s de giro y 5 s mostrando el resultado.
- Pleno 35:1 · Docena y columna 2:1 · Rojo/Negro, Par/Impar, 1-18/19-36 1:1.
- Se guardan en base de datos los **últimos 30 giros** (tabla `roulette_spins`).

## Blackjack

- **5 mesas de 15 jugadores**. Arriba de la mesa puedes cambiar de mesa y ver cuántos hay en cada
  una. Solo puedes estar sentado en una mesa a la vez, pero puedes mirar las demás.
- 8 barajas, el crupier se planta en 17, blackjack paga 3:2, doblar con dos cartas y
  dividir una vez.
- La mano se reparte cuando todos los sentados apostaron o 15 s después de la primera
  apuesta. Las cartas se dan una a una (como en una mesa real) y salen animadas desde
  el zapato; la carta tapada del crupier se gira al descubrirse. Cada jugador tiene 20 s por turno (si no, se planta solo).
- Si cierras la pestaña, conservas el asiento 20 s por si recargas.

## Límite de cuentas

- Solo limita **crear** cuentas; entrar con una existente funciona siempre.
- **Por dispositivo:** una cookie permanente (`ksdev`, 5 años) identifica el navegador. Borrar
  cookies o usar incógnito la esquiva, y para eso está el límite por IP.
- **Por IP:** usa la IP real que manda Cloudflare. Tiene ventana de tiempo para no bloquear
  para siempre redes compartidas (universidades, datos móviles con IP compartida).
- En la tabla `registrations` se guardan HMAC del dispositivo y de la IP, nunca los valores en claro.
- En desarrollo, pon `ACCOUNTS_PER_DEVICE=0` y `ACCOUNTS_PER_IP=0` para poder crear cuentas de prueba.

## Cámaras y chat de voz en la mesa de blackjack

- Al sentarte, la web pregunta si quieres activar la cámara, con la opción de activar también
  el micrófono ("Ahora no" deja todo apagado). Luego hay botones para cámara y micrófono junto a
  *Levantarse*; al levantarte se apagan.
- Tu vídeo sustituye a tu foto en tu silla (320×240, 15 fps, ~250 kbps por espectador). Tu voz
  la oyen todos los que miran la mesa; un aro verde marca quién está hablando y aparece un
  micrófono junto al nombre de quien lo tiene abierto.
- Solo pueden hablar y mostrarse los que están sentados; los espectadores ven y oyen. Cualquiera
  puede pulsar *Silenciar mesa*. Si el navegador bloquea el sonido automático (Safari), aparece
  *Activar sonido de la mesa*.
- Vídeo y voz van directo de navegador a navegador (WebRTC); el servidor solo pone en contacto
  a los jugadores y no ve, oye ni guarda nada. Cada jugador envía una copia a cada espectador
  (máximo 20).
- Necesita HTTPS (o `localhost`). Con el STUN por defecto conecta en la mayoría de redes; en
  datos móviles o redes corporativas puede fallar sin un servidor **TURN** (por ejemplo coturn
  propio o un servicio como Metered o Twilio) configurado en `RTC_ICE_SERVERS`.

## Estructura

```
db/
  schema.sql    Esquema MySQL (lo aplica la app al arrancar)
src/
  server.js     Express + Socket.IO, arranque y autenticación de sockets
  db.js         Conexión a MySQL (pool, transacciones, ID público)
  queue.js      Cola que ejecuta las operaciones de cada juego de una en una
  auth.js       Registro, login y sesiones JWT (cookie httpOnly)
  avatars.js    Fotos de perfil: validación y almacenamiento
  profile.js    Rutas para subir, quitar y servir la foto
  transfers.js  Envío de créditos entre jugadores por ID
  chat.js       Chat de la ruleta y de cada mesa (el servidor también reenvía la
                señalización WebRTC de las cámaras, en server.js)
  wallet.js     Único módulo que modifica créditos
  roulette.js   Lógica de la ruleta
  blackjack.js  Lógica de las mesas de blackjack
public/         Cliente: Bootstrap 5 + Bootstrap Icons, JS sin frameworks y sin build.
                Bootstrap, iconos, fuentes (Inter, Cinzel) y canvas-confetti se sirven
                desde node_modules en /vendor (mismo origen, sin CDN).
```
