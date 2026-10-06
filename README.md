# Ksinito

Casino online con **Ruleta** y **Blackjack** multijugador en tiempo real, con créditos ficticios,
una **Trivia** de preguntas con apuesta y un minijuego gratis de **Patos** para ganar créditos.

## Base de datos: MySQL

Todo (cuentas, créditos, registro de movimientos, fotos, chat, transferencias, anuncios vistos,
historial de la ruleta y el secreto de las sesiones) se guarda en **MySQL 8.0+** o un servicio compatible.
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
| `ADS_ENABLED`        | `0` oculta el botón de anuncios y hace que sus rutas respondan 404 (por defecto `1`) |
| `AD_REWARD`          | Créditos por anuncio completado (por defecto `100`)                               |
| `AD_DURATION_SECONDS` | Segundos mínimos de anuncio antes de poder reclamar (por defecto `30`)           |
| `AD_COOLDOWN_SECONDS` | Segundos mínimos entre dos anuncios del mismo jugador (por defecto `300`)        |
| `AD_DAILY_LIMIT`     | Máximo de anuncios **cobrados** por jugador en 24 h (por defecto `10`; `0` = ninguno) |
| `AD_CLAIM_WINDOW_SECONDS` | Segundos para reclamar una vez terminado el anuncio (por defecto `300`)     |
| `DUCKS_ENABLED`      | `0` oculta el juego de patos y rechaza sus eventos (por defecto `1`)              |
| `DUCK_REWARD`        | Créditos por pato derribado (por defecto `2`)                                     |
| `DUCKS_PER_ROUND`    | Patos por ronda, de 1 a 50 (por defecto `10`)                                     |
| `DUCKS_DAILY_CREDIT_LIMIT` | Máximo de créditos ganados con patos en 24 h (por defecto `100`; `0` = no se pueden ganar) |
| `DUCKS_ROUND_COOLDOWN_SECONDS` | Espera mínima entre el fin de una ronda y la siguiente (por defecto `10`) |

Las variables numéricas se validan al arrancar: si una no es un entero válido, se usa el valor
por defecto y se avisa en la consola.

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

## Ranking y rangos

- La pestaña **Ranking** muestra el top 10 de jugadores con más créditos (podio para los tres
  primeros), tu posición si no estás en el top, tu rango y la tabla de rangos. Se actualiza
  sola cada 15 s mientras está abierta.
- El **rango** depende del total que has apostado en ruleta, blackjack y trivia (incluye doblar y
  dividir). Las apuestas que retiras antes de jugarse se descuentan, así que apostar y retirar
  en bucle no sirve para subir. Se guarda en `users.wagered`.
- Rangos, de menor a mayor (desde cuánto apostado empieza cada uno):

  | Rango | Desde | Divisiones (I · II · III) |
  |---|---|---|
  | Aprendiz | 0 | 0 · 300 · 600 |
  | Jugador | 1.000 | 1.000 · 2.000 · 3.500 |
  | Apostador | 5.000 | 5.000 · 10.000 · 15.000 |
  | Tahúr | 20.000 | 20.000 · 35.000 · 55.000 |
  | As | 75.000 | 75.000 · 125.000 · 185.000 |
  | Magnate | 250.000 | 250.000 · 400.000 · 575.000 |
  | Barón | 750.000 | 750.000 · 1.150.000 · 1.550.000 |
  | Leyenda | 2.000.000 | 2.000.000 · 3.000.000 · 4.000.000 |
  | Mito | 5.000.000 | (sin divisiones) |

- Cada rango tiene su emblema (SVG generado en `public/js/ranks.js`), y la división se muestra
  con 1–3 gemas. El emblema aparece junto a tu avatar, en el chat, en las sillas del blackjack y
  en el ranking. Al subir de división sale un anuncio en el centro de la pantalla.
- Los umbrales se cambian en `TIERS` de `src/ranks.js`.

## Créditos

- Cada cuenta recibe **100 créditos una sola vez**, al iniciar sesión por primera vez.
  La columna `welcome_bonus_granted` evita que se vuelvan a dar.
- Los créditos se guardan en MySQL (tabla `users`) y cada movimiento queda registrado en la
  tabla `ledger` (apuestas, premios, reembolsos, bono, envíos).
- **No se pueden dar créditos desde la consola del navegador**: el cliente solo envía
  intenciones ("apuesto 10 al rojo", "pido carta"). El servidor valida cada apuesta
  (entero, límites, fase del juego, turno, saldo), baraja, reparte, gira la ruleta con
  `crypto.randomInt` y calcula los pagos. Las únicas formas de sumar créditos sin apostar son
  los anuncios con recompensa y el juego de patos (abajo), y en los dos el servidor decide por
  su cuenta si se ganaron. La carta tapada del crupier nunca se envía al cliente hasta que se
  revela.

## Anuncios con recompensa

- El botón **▶ +100** (arriba, junto a tus créditos) abre un anuncio. Al terminar la cuenta
  atrás se puede reclamar la recompensa (`AD_REWARD`, 100 créditos por defecto). Se abona con
  `wallet.js` y queda en `ledger` con el motivo `ad_reward:<id>`.
- **Límites:** un anuncio cada `AD_COOLDOWN_SECONDS` (5 min) y como máximo `AD_DAILY_LIMIT`
  (10) cobrados en 24 h. El botón muestra la espera (mm:ss) o "Vuelve mañana".
- **El servidor valida el tiempo por su cuenta.** Al empezar, crea un token aleatorio de un
  solo uso con `ready_at = NOW() + AD_DURATION_SECONDS` en MySQL. Solo lo paga si es de ese
  jugador, no se ha cobrado y `NOW()` de MySQL está entre `ready_at` y `expires_at`
  (`ready_at + AD_CLAIM_WINDOW_SECONDS`). El cobro es un `UPDATE` condicional en la misma
  transacción que el abono, así que dos peticiones a la vez con el mismo token pagan una sola
  vez. El contador del navegador (que se pausa si cambias de pestaña) es solo informativo.
- Recargar la página o cancelar no da un anuncio nuevo: el botón retoma el pendiente con el
  mismo token.
- Cada anuncio empezado queda en la tabla `ad_rewards` con su `ad_id`, para saber cuántas veces
  se vio cada uno.

### Añadir un anuncio

1. Copia el archivo en `public/spots/`: vídeo MP4 o WebM, o imagen WebP o JPEG (mejor 16:9). Si
   cambias un anuncio, usa un nombre de archivo nuevo: Cloudflare y los navegadores guardan en
   caché el anterior.
2. Añádelo a `src/ads.config.json` (no es público) y reinicia la app:

   ```json
   {
     "id": "colxsoft-01",
     "type": "video",
     "src": "/spots/colxsoft-01.mp4",
     "title": "ColxSoft — desarrollo web a la medida",
     "link": "https://ejemplo.com",
     "active": true,
     "weight": 1
   }
   ```

   - `id`: único, de 1 a 64 letras, números, `.`, `_` o `-`.
   - `type`: `video` o `image`. `src`: un archivo que exista directamente en `public/spots/`.
   - `link` (opcional): `https://`. La imagen o el vídeo se vuelven clicables y aparece el botón
     *Ver más*; los dos abren el enlace en otra pestaña.
   - `active: false` lo retira sin borrarlo. `weight` (entero de 1 a 1000): los de más peso
     salen más a menudo.

   Al arrancar se valida cada entrada; las que no son válidas se descartan con un aviso en la
   consola. Si no queda ningún anuncio activo, el botón no aparece.
- Solo anuncios propios, servidos desde el mismo dominio: no se carga nada de redes
  publicitarias. La elección del anuncio está en `pickAd()` (`src/ads.js`), para poder
  cambiarla por un proveedor externo sin tocar la lógica de recompensa.
- **Bloqueadores de anuncios:** uBlock, AdBlock o Brave ocultan elementos con nombres como
  `#ad-wrap` o `.ad-btn` y bloquean rutas `/ads/` en algunos dominios. Por eso el cliente usa
  `js/rewards.js` e ids/clases `rw-*`, y los archivos van en `public/spots/`. No uses "ad" o
  "ads" en nombres nuevos del cliente.

## Patos

Minijuego individual para ganar créditos cuando te quedas sin saldo: **jugar es gratis** y cada
pato derribado da **2 créditos** (`DUCK_REWARD`). No es un juego de apuestas.

- **Reglas:** una ronda son 10 patos (`DUCKS_PER_ROUND`) que salen de 2 en 2, en 5 oleadas.
  Cada pato está en pantalla como máximo 5 s; si no le das, escapa volando hacia arriba. Tienes
  **3 disparos por oleada**: sin balas, los patos que quedan escapan. La velocidad sube un poco en
  cada oleada. Al terminar ves cuántos derribaste y cuánto ganaste (máximo 20 créditos por ronda
  con los valores por defecto).
- **Recompensa:** los créditos se suman **una sola vez, al cerrar la ronda**, en una
  transacción que la marca como cobrada (`duck_rounds.credited_at`) y los abona con `wallet.js`
  (motivo `duck_reward:<id>` en `ledger`). Si te desconectas a mitad de ronda, se cierra y se
  paga lo ganado a los 30 s (o al terminar sus oleadas); recargar la página recupera la ronda.
- **Tope diario:** como máximo `DUCKS_DAILY_CREDIT_LIMIT` (100) créditos con patos en 24 h. La
  ronda que lo alcanza cobra solo lo que falta, y después el botón muestra "Vuelve en hh:mm".
  Entre rondas hay que esperar `DUCKS_ROUND_COOLDOWN_SECONDS` (10 s). Solo una ronda a la vez.
- **El servidor decide todo.** Genera los patos con `crypto` a partir de una semilla por
  ronda, los envía uno a uno cuando aparecen y calcula si cada disparo acierta con la misma
  función de trayectoria que dibuja el navegador (`public/js/duck-path.js`). El navegador solo
  envía "disparé en (x, y) en el instante t". Un disparo no cuenta si `t` se aleja más de
  500 ms del reloj del servidor, si llega antes de 250 ms desde que apareció el pato o después
  de que escape, o si ya no quedan balas. Hay un límite de 10 disparos por segundo.
- Con ratón aparece una mira; en móvil se toca donde está el pato (mejor en horizontal; hay
  botón de pantalla completa). Si cambias de pestaña se muestra "Pausado", pero la ronda sigue
  en el servidor.
- Dibujos (patos, atardecer con lago y juncos) hechos en canvas y sonidos generados con Web
  Audio API: sin imágenes ni audios externos. Botón para silenciar.
- `npm test` ejecuta las pruebas de la trayectoria y de la validación de disparos (`test/`).

## Fichas

1, 5, 10, 25, 100, 500, 1K, 5K, 25K y 100K, en la ruleta y en el blackjack. Las cantidades
grandes se muestran abreviadas en las fichas de la mesa ("100K", "1,5K"). En móvil la fila de
fichas se desliza en horizontal.

## Ruleta

- Ruleta europea (un cero), con rondas compartidas por todos: 20 s de apuestas,
  7 s de giro y 5 s mostrando el resultado.
- Pleno 35:1 · Docena y columna 2:1 · Rojo/Negro, Par/Impar, 1-18/19-36 1:1.
- Máximo **100.000 por ronda** (también por casilla: se puede poner todo en un número).
- Se guardan en base de datos los **últimos 30 giros** (tabla `roulette_spins`).

## Blackjack

- **3 mesas públicas de 15 jugadores**. Arriba de la mesa puedes cambiar de mesa y ver cuántos
  hay en cada una. Solo puedes estar sentado en una mesa a la vez, pero puedes mirar las demás.
- **Salas personalizadas**: con el botón **+** junto a las mesas creas una sala eligiendo de **2 a
  15 jugadores** (la mesa tiene exactamente esas sillas). Cada sala tiene un **código de 4
  caracteres** (letras y números, sin 0/O ni 1/I para no confundirlos) que se comparte para que
  otros entren con «Unirse con código». No salen en la lista pública: a cada jugador le aparecen
  las salas en las que ha entrado, con botones para copiar el código y quitarla de su lista.
  Tienen su propio chat. Cada jugador puede tener una sala abierta a la vez; se cierra sola tras
  2 minutos sin nadie sentado ni mirando (y su chat se borra). Viven en memoria: un reinicio del
  servidor las cierra.
- Apuesta máxima **200.000 por mano** (doblar y dividir cobran otro tanto).
- 8 barajas, el crupier se planta en 17, blackjack paga 3:2, doblar con dos cartas y
  dividir una vez.
- La mano se reparte cuando todos los sentados apostaron o 15 s después de la primera
  apuesta. Las cartas se dan una a una (como en una mesa real) y salen animadas desde
  el zapato; la carta tapada del crupier se gira al descubrirse. Cada jugador tiene 20 s por turno (si no, se planta solo).
- Si cierras la pestaña, conservas el asiento 20 s por si recargas.

## Trivia

- Apuestas de **10 a 100.000** y respondes **8 preguntas**. Antes de cada una gira una ruleta con
  seis categorías, según el **modo** que elijas (se recuerda el último en ese navegador):
  - **Clásica**: ciencia, geografía, historia, cine, arte y deportes.
  - **Tecnología**: hardware, software, sistemas operativos, internet, programación y empresas
    (unas 236 preguntas, entre 29 y 47 por categoría).

  Los dos modos tienen los mismos pagos y límites. Cada partida guarda su modo en
  `trivia_rounds.mode`.
- Ficha **ALL-IN**: apuesta todo tu saldo de una vez (hasta el máximo de 100.000).
- Al terminar cobras según los aciertos: **8/8 ×2,5**, **7/8 y 6/8 ×2**, **5/8 ×1,5** (redondeado
  hacia abajo); con menos de 5 pierdes lo apostado.
- **10 s por pregunta**; si se acaba el tiempo cuenta como fallo. Si no pulsas "Girar" en 30 s,
  la ruleta gira sola, así que una partida abandonada siempre termina.
- **El servidor decide todo**: la categoría, la pregunta y el orden de las opciones. La pregunta
  no se envía hasta que la ruleta termina de girar, y cuál era la correcta solo se envía después
  de responder.
- **Más de 1.000 preguntas** (entre 128 y 233 por categoría), en dos archivos:
  - `src/trivia-questions.js`: preguntas propias, muchas sobre México, Latinoamérica y España.
  - `src/trivia-questions-opentdb.js`: preguntas de [Open Trivia DB](https://opentdb.com)
    traducidas al español y revisadas (se quitaron las que solo funcionan en inglés, las
    repetidas, las dudosas o que cambian con el tiempo y las muy locales de EE. UU. o Reino
    Unido). Su licencia, CC BY-SA 4.0, pide dar crédito: lo hace la línea bajo la trivia. Si
    se retira ese archivo, hay que quitar también esa línea.
- **Sin repeticiones:** cada pregunta que ve un jugador se guarda en `trivia_seen`, y siempre
  le sale una que no haya visto nunca. Solo cuando ya vio todas las de una categoría vuelve a
  sacarle de las que vio hace más tiempo. Sobrevive a los reinicios y redeploys.
- Para añadir preguntas, ponlas en `src/trivia-questions.js` con la respuesta correcta la
  primera (el servidor baraja las opciones). Evita preguntas cuya respuesta cambie con el
  tiempo. `npm test` comprueba que cada una tenga 4 opciones distintas y que no haya repetidas.
  El id de cada pregunta sale de su texto: si corriges un enunciado, cuenta como pregunta nueva.
- Cada partida se guarda en `trivia_rounds` (apuesta, aciertos, pago y preguntas que salieron).
  Si el servidor se reinicia con una partida a medias, al arrancar se devuelve la apuesta.
- Al recargar la página vuelves a la partida en juego, con el tiempo que quedaba.
- La pregunta y las opciones no se pueden seleccionar, copiar ni arrastrar (tampoco mantener
  pulsado en el móvil), y mientras hay una pregunta en pantalla no se copia nada de la página.
  Es una barrera para no pegarla en un buscador, no una garantía: con una captura de pantalla
  o las herramientas de desarrollador se puede leer igual. La defensa real son los 10 s.
  Si aun así hay abusos, baja `MAX_BET`, `ANSWER_MS` o los multiplicadores (constantes al
  principio de `src/trivia.js`).

## Cosméticos

- **Cosméticos** (en tu perfil: pulsa tu foto arriba y luego «Cosméticos»; «Volver» te regresa a donde estabas): bordes de perfil animados que se ven alrededor de tu foto en las mesas
  de blackjack, el chat, el ranking y tu perfil (en el chat, la barra de arriba y las filas del
  ranking solo el aro, porque los adornos no caben).
- Cuatro niveles, seis bordes en cada uno: tres con formas propias y tres con alas metálicas.

  | Nivel | Precio | Formas | Alas |
  |---|---|---|---|
  | Básico | 12.000 | Hexágono de Acero (marco hexagonal), Laurel de Bronce (corona de laurel con lazo), Engranaje de Cobre (engranaje que gira) | Alas de Hierro, de Bronce, de Plata |
  | Especial | 16.000 | Escudo de Caballero (escudo con espadas cruzadas), Loto de Jade (pétalos que respiran), Neón Felino (orejas y bigotes de gato en neón) | Acero Azul, Jade Imperial, Cobre Ardiente |
  | Legendario | 20.000 | Tormenta Eléctrica (rayos que destellan), Llamas Infernales (fuego que baila), Corona de Hielo (cristales y escarcha) | Corona de Oro, Zafiro Real, Amatista Arcana |
  | Mítico | 30.000 | Dragón Carmesí (alas de murciélago, cuernos y cola), Galaxia (nebulosa y planetas en órbita), Sol Eterno (rayos de sol que giran) | Fénix, Dragón de Obsidiana, Serafín |

- Al pulsar un borde se ve en grande con tu foto. Comprar pide un segundo clic para confirmar,
  y el borde se equipa al comprarlo. Puedes cambiar entre los que tengas o quitártelo.
- Comprar **no cuenta como apuesta** (no sube el rango). Cada compra queda en el registro de
  movimientos (`cosmetic:<id>`) y en `user_cosmetics`; el borde equipado, en `users.frame`.
- Para añadir un borde: su id, nombre y nivel en `FRAMES` de `src/cosmetics.js` (el precio sale
  del nivel) y su dibujo, con el mismo id, en `FRAMES` de `public/js/frames.js` (con alas, o con
  un `kind` que tenga su función en `BUILDERS`). `npm test` comprueba que estén los dos. Los ids
  no se cambian nunca: son los que quedan guardados en las compras.

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
  ads.js        Anuncios con recompensa: catálogo, límites, token de un solo uso y rutas
  ads.config.json  Catálogo de anuncios (archivos en public/spots/)
  chat.js       Chat de la ruleta y de cada mesa (el servidor también reenvía la
                señalización WebRTC de las cámaras, en server.js)
  wallet.js     Único módulo que modifica créditos (y el total apostado)
  ranks.js      Rangos por total apostado y ranking del top 10
  roulette.js   Lógica de la ruleta
  blackjack.js  Lógica de las mesas de blackjack
  ducks.js      Juego de patos: rondas, patos, validación de disparos, tope diario y pago
  trivia.js     Trivia: partidas, ruleta de categorías, preguntas, tiempos y pago
  trivia-questions.js  Preguntas propias de la trivia, por categoría
  trivia-questions-opentdb.js  Preguntas de Open Trivia DB traducidas (CC BY-SA 4.0)
  cosmetics.js  Tienda de bordes de perfil: catálogo, precios, compra y borde equipado
  env.js        Lectura y validación de variables de entorno numéricas
public/         Cliente: Bootstrap 5 + Bootstrap Icons, JS sin frameworks y sin build.
                Bootstrap, iconos, fuentes (Inter, Cinzel) y canvas-confetti se sirven
                desde node_modules en /vendor (mismo origen, sin CDN).
  spots/        Vídeos e imágenes de los anuncios con recompensa
  js/ducks.js   Juego de patos en el navegador (canvas, sonidos, marcador)
  js/duck-path.js  Trayectoria de los patos (módulo ESM que usan el navegador y el servidor)
  js/trivia.js  Trivia en el navegador (ruleta de categorías, preguntas, resultado)
  js/frames.js  Dibujo de los bordes de perfil (SVG con alas metálicas, animados)
  js/cosmetics.js  Pestaña de la tienda de cosméticos
test/           Pruebas (npm test, con node:test)
```
