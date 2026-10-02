-- Esquema MySQL de Ksinito.
--
-- Compatible con MySQL 8.0+ y servicios gestionados compatibles (TiDB Cloud, Aiven,
-- PlanetScale, Railway…). Todas las sentencias son idempotentes: la app lo ejecuta
-- sola al arrancar, y también puedes pegarlo en la consola SQL de tu proveedor
-- antes del primer deploy.
--
-- No usa FOREIGN KEY para funcionar también en proveedores basados en Vitess
-- (PlanetScale); las cuentas nunca se borran, así que no hacen falta cascadas.
-- Las fechas son milisegundos desde 1970 (Date.now() en Node).

-- Cuentas. `public_id` es el ID de 8 cifras que se comparte para recibir créditos.
CREATE TABLE IF NOT EXISTS users (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id             CHAR(8)         NOT NULL,
  username              VARCHAR(20)     NOT NULL,
  password_hash         VARCHAR(100)    NOT NULL,
  credits               BIGINT          NOT NULL DEFAULT 0,
  -- Total apostado (apuestas menos reembolsos); decide el rango del jugador (src/ranks.js).
  wagered               BIGINT          NOT NULL DEFAULT 0,
  welcome_bonus_granted TINYINT(1)      NOT NULL DEFAULT 0,
  created_at            BIGINT          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY users_username (username),
  UNIQUE KEY users_public_id (public_id),
  KEY users_credits (credits), -- ranking por créditos
  CONSTRAINT users_credits_not_negative CHECK (credits >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registro de cada movimiento de créditos (auditoría): apuestas, premios, bono, envíos.
CREATE TABLE IF NOT EXISTS ledger (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  delta         BIGINT          NOT NULL,
  balance_after BIGINT          NOT NULL,
  reason        VARCHAR(64)     NOT NULL,
  created_at    BIGINT          NOT NULL,
  PRIMARY KEY (id),
  KEY ledger_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Altas de cuentas, para limitar cuántas se crean por dispositivo y por IP.
-- El dispositivo (cookie permanente) y la IP se guardan como HMAC, nunca en claro.
CREATE TABLE IF NOT EXISTS registrations (
  user_id     BIGINT UNSIGNED NOT NULL,
  device_hash CHAR(64)        NOT NULL,
  ip_hash     CHAR(64)        NOT NULL,
  created_at  BIGINT          NOT NULL,
  PRIMARY KEY (user_id),
  KEY registrations_device (device_hash),
  KEY registrations_ip (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Envíos de créditos entre jugadores.
CREATE TABLE IF NOT EXISTS transfers (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_user  BIGINT UNSIGNED NOT NULL,
  to_user    BIGINT UNSIGNED NOT NULL,
  amount     BIGINT          NOT NULL,
  created_at BIGINT          NOT NULL,
  PRIMARY KEY (id),
  KEY transfers_from (from_user, id),
  KEY transfers_to (to_user, id),
  CONSTRAINT transfers_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fotos de perfil (hasta 300 KB, ya recortadas a 256×256 por el navegador).
CREATE TABLE IF NOT EXISTS avatars (
  user_id    BIGINT UNSIGNED NOT NULL,
  mime       VARCHAR(16)     NOT NULL,
  data       MEDIUMBLOB      NOT NULL,
  updated_at BIGINT          NOT NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chat: canal "roulette" y uno por mesa de blackjack ("bj:1"…). Se guardan los últimos 200 por canal.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel    VARCHAR(16)     NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  text       VARCHAR(300)    NOT NULL,
  created_at BIGINT          NOT NULL,
  PRIMARY KEY (id),
  KEY chat_channel (channel, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Últimos 30 números de la ruleta.
CREATE TABLE IF NOT EXISTS roulette_spins (
  id         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  number     TINYINT UNSIGNED NOT NULL,
  created_at BIGINT           NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT roulette_number_range CHECK (number <= 36)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ajustes internos. Guarda el secreto de las sesiones (JWT) si no se define JWT_SECRET,
-- para que las sesiones sobrevivan a los deploys.
CREATE TABLE IF NOT EXISTS settings (
  name  VARCHAR(64)  NOT NULL,
  value VARCHAR(255) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anuncios con recompensa (src/ads.js). Cada fila es un anuncio empezado; `token` es de un
-- solo uso y `claimed_at` se rellena al cobrarlo. A diferencia del resto, las fechas son
-- DATETIME porque todas las comprobaciones de tiempo se hacen con NOW() de MySQL (ni el reloj
-- del navegador ni el de Node cuentan). `ad_id` permite contar cuántas veces se vio cada anuncio.
CREATE TABLE IF NOT EXISTS ad_rewards (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  ad_id      VARCHAR(64)     NOT NULL,
  token      CHAR(32)        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reward     INT             NOT NULL,
  created_at DATETIME        NOT NULL,
  ready_at   DATETIME        NOT NULL,
  expires_at DATETIME        NOT NULL,
  claimed_at DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token),
  KEY idx_user_created (user_id, created_at),
  KEY idx_user_claimed (user_id, claimed_at),
  KEY idx_ad (ad_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rondas del minijuego "Patos" (src/ducks.js). La ronda en juego vive en memoria; esta tabla
-- guarda el historial y sirve para el cooldown entre rondas y el tope diario de créditos
-- (SUM(reward) de las rondas cobradas en las últimas 24 h). `credited_at` se rellena al pagar la
-- ronda con un UPDATE condicional, así que cada ronda se paga una sola vez. Como en ad_rewards,
-- las fechas son DATETIME porque los límites se comparan con NOW() de MySQL. `seed` permite
-- reconstruir los patos de la ronda.
CREATE TABLE IF NOT EXISTS duck_rounds (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  seed        CHAR(32)        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at  DATETIME        NOT NULL,
  ended_at    DATETIME        NULL,
  ducks_total INT             NOT NULL,
  ducks_hit   INT             NOT NULL DEFAULT 0,
  shots       INT             NOT NULL DEFAULT 0,
  reward      INT             NOT NULL DEFAULT 0,
  credited_at DATETIME        NULL,
  PRIMARY KEY (id),
  KEY idx_user_started (user_id, started_at),
  KEY idx_user_credited (user_id, credited_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partidas de la trivia (src/trivia.js). La partida en juego vive en memoria; esta fila se crea
-- en la misma transacción que cobra la apuesta y se cierra con un UPDATE condicional
-- (status = 'playing'), así que cada partida se paga una sola vez. Si un reinicio deja alguna
-- a medias, al arrancar se devuelve la apuesta (status = 'refunded'). `questions` guarda las
-- preguntas que salieron ("cine:3+,arte:7-": + acierto, - fallo).
CREATE TABLE IF NOT EXISTS trivia_rounds (
  id         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED  NOT NULL,
  bet        BIGINT           NOT NULL,
  status     VARCHAR(10)      NOT NULL,
  correct    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  payout     BIGINT           NOT NULL DEFAULT 0,
  questions  VARCHAR(255)     NULL,
  created_at BIGINT           NOT NULL,
  ended_at   BIGINT           NULL,
  PRIMARY KEY (id),
  KEY trivia_user (user_id, id),
  KEY trivia_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
