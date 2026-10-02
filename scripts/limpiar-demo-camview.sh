#!/usr/bin/env bash
# Borra SOLO los datos que deja demo-camview.sh (placas DMA###, DMB###, DMC###
# y las cámaras llamadas "(demo)"), dejando el resto de la base intacto.
# Uso (Git Bash, con el contenedor transdier-db arriba):  bash API/scripts/limpiar-demo-camview.sh
set -euo pipefail

CONTAINER="${DB_CONTAINER:-transdier-db}"
DB_PASS="${DB_PASSWORD:-transdier}"
UPLOADS="$(dirname "$0")/../uploads/camera"

docker exec -i "$CONTAINER" mariadb -uroot -p"$DB_PASS" transdier_v2 <<'SQL'
DELETE FROM camera_readings WHERE normalized_plate REGEXP '^DM[ABC][0-9]{3}$';
DELETE FROM operation_events WHERE operation_id IN (SELECT id FROM operations WHERE normalized_plate REGEXP '^DM[AB][0-9]{3}$');
DELETE FROM operations WHERE normalized_plate REGEXP '^DM[AB][0-9]{3}$';
DELETE FROM vehicles WHERE normalized_plate REGEXP '^DM[AB][0-9]{3}$';
DELETE FROM notifications WHERE message REGEXP 'DM[AB][0-9]{3}' AND type IN ('vehicle:registered','vehicle:duplicate_attempt');
DELETE FROM camera_devices WHERE name LIKE '%(demo)%' AND id NOT IN (SELECT camera_id FROM camera_readings);
SELECT (SELECT COUNT(*) FROM operations WHERE normalized_plate REGEXP '^DM[AB][0-9]{3}$') AS tickets_demo_restantes,
       (SELECT COUNT(*) FROM camera_readings WHERE normalized_plate REGEXP '^DM[ABC][0-9]{3}$') AS lecturas_demo_restantes;
SQL

if [ -d "$UPLOADS" ]; then
  find "$UPLOADS" -type f -name 'demo-*.jpg' -delete
  find "$UPLOADS" -type d -empty -delete 2>/dev/null || true
fi
echo "Datos de la demo eliminados."
