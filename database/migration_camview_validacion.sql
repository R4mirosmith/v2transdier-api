-- Validación pasiva con cámara (CAMVIEW).
-- Ejecutar una vez en transdier_v2 (local y en el VPS) antes de publicar el API con el módulo camview.
-- Idempotente: se puede volver a ejecutar sin daño (MariaDB 10.3+).

CREATE TABLE IF NOT EXISTS camera_devices (
  id BIGINT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  ferry_id BIGINT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_seen_at_utc DATETIME NULL,
  last_event_type VARCHAR(40) NULL,
  created_by_user_id BIGINT NULL,
  created_at_utc DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_camera_devices_token (token_hash),
  KEY fk_camera_devices_ferry (ferry_id),
  KEY fk_camera_devices_created_by (created_by_user_id),
  CONSTRAINT fk_camera_devices_ferry FOREIGN KEY (ferry_id) REFERENCES ferries (id),
  CONSTRAINT fk_camera_devices_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS camera_readings (
  id BIGINT NOT NULL AUTO_INCREMENT,
  camera_id BIGINT NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  normalized_plate VARCHAR(20) NOT NULL,
  raw_text VARCHAR(40) NULL,
  vehicle_type VARCHAR(20) NULL,
  confidence DECIMAL(5,4) NULL,
  detected_at_utc DATETIME NOT NULL,
  crop_path VARCHAR(255) NULL,
  trip_id BIGINT NULL,
  operation_id BIGINT NULL,
  created_at_utc DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_camera_readings_event (event_id),
  KEY idx_camera_readings_trip_plate (trip_id, normalized_plate),
  KEY idx_camera_readings_detected (detected_at_utc),
  KEY fk_camera_readings_camera (camera_id),
  KEY fk_camera_readings_operation (operation_id),
  CONSTRAINT fk_camera_readings_camera FOREIGN KEY (camera_id) REFERENCES camera_devices (id),
  CONSTRAINT fk_camera_readings_trip FOREIGN KEY (trip_id) REFERENCES trips (id),
  CONSTRAINT fk_camera_readings_operation FOREIGN KEY (operation_id) REFERENCES operations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS camera_validated_at_utc DATETIME NULL AFTER boarded_at_utc,
  ADD COLUMN IF NOT EXISTS camera_reading_id BIGINT NULL AFTER camera_validated_at_utc,
  ADD COLUMN IF NOT EXISTS camera_photo_path VARCHAR(255) NULL AFTER camera_reading_id,
  ADD INDEX IF NOT EXISTS idx_operations_camera_validated (camera_validated_at_utc);
