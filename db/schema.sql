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
  welcome_bonus_granted TINYINT(1)      NOT NULL DEFAULT 0,
  created_at            BIGINT          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY users_username (username),
  UNIQUE KEY users_public_id (public_id),
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
