#!/usr/bin/env bash
# Demostración de la validación pasiva con cámara SIN cámara física.
# Requisitos: API en http://localhost:4010 con la migración camview aplicada, usuario admin/admin123.
# Uso (Git Bash):
#   bash API/scripts/demo-camview.sh                      # crea una cámara "(demo)" nueva y muestra su token
#   CAM_TOKEN=xxxx bash API/scripts/demo-camview.sh       # reutiliza el token de una cámara ya registrada
# Para borrar lo que deja la demo:  bash API/scripts/limpiar-demo-camview.sh
set -euo pipefail

API="${API_URL:-http://localhost:4010}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
CROP_FILE="${CROP_FILE:-$(dirname "$0")/../uploads/vehicle-categories/1788794007723-159369144.jpg}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

echo "== 1. Login admin"
TOKEN=$(curl -s -H "Content-Type: application/json" -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" "$API/api/auth/login" | json 'v.token')
AUTH="Authorization: Bearer $TOKEN"

echo "== 2. Trayecto abierto"
TRIP=$(curl -s -H "$AUTH" "$API/api/trips/open" | json '(v.data[0]||{}).id||""')
if [ -z "$TRIP" ]; then
  JID=$(curl -s -H "$AUTH" "$API/api/journeys/open" | json '(v.data[0]||{}).id||""')
  [ -z "$JID" ] && JID=$(curl -s -H "$AUTH" -H "Content-Type: application/json" -d '{"ferry_id":1}' "$API/api/journeys/open" | json 'v.data.id')
  TRIP=$(curl -s -H "$AUTH" -H "Content-Type: application/json" -d "{\"journey_id\":$JID,\"route_id\":1}" "$API/api/trips/open" | json 'v.data.id')
fi
echo "   trayecto #$TRIP"

echo "== 3. Cámara en el servidor"
if [ -n "${CAM_TOKEN:-}" ]; then
  echo "   usando el token de cámara recibido por CAM_TOKEN"
else
  CAM_JSON=$(curl -s -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"Rampa de cobro (demo)","ferry_id":1}' "$API/api/camview/cameras")
  CAM_TOKEN=$(echo "$CAM_JSON" | json 'v.data.token')
  echo "   cámara nueva creada · token: $CAM_TOKEN"
  echo "   webhook: $(echo "$CAM_JSON" | json 'v.data.webhook_url')"
fi

echo "== 4. Tipo de vehículo para la demo"
TYPE_ID=$(curl -s -H "$AUTH" "$API/api/catalog/vehicle-types" | json 'v.data.find(t=>t.plate_category==="VEHICLE"&&!t.registration_restricted).id')
echo "   vehicle_type_id=$TYPE_ID"

CROP_B64=$(base64 -w0 "$CROP_FILE" 2>/dev/null || base64 "$CROP_FILE" | tr -d '\n')
camera_event() {
  curl -s -H "Authorization: Bearer $CAM_TOKEN" -H "Content-Type: application/json" \
    -d "{\"event\":\"plate_detected\",\"event_id\":\"demo-$1-$(date +%s%N)\",\"plate\":\"$1\",\"raw_text\":\"$1\",\"valid\":true,\"vehicle_type\":\"car\",\"confidence\":0.97,\"detected_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"camera\",\"crop_jpeg_base64\":\"$CROP_B64\"}" \
    "$API/api/camview/events"
}
register() {
  curl -s -H "$AUTH" -F "trip_id=$TRIP" -F "plate=$1" -F "vehicle_type_id=$TYPE_ID" -F "load_status=NA" \
    -F "driver_name=CONDUCTOR GENERAL" -F "driver_document=NO REGISTRA" -F "driver_phone=NO REGISTRA" \
    "$API/api/operations/register"
}

SUFFIX=$(( RANDOM % 900 + 100 ))
P1="DMA$SUFFIX"   # ticket primero, cámara después
P2="DMB$SUFFIX"   # cámara primero, ticket después

echo "== 5. Caso A: el cobrador registra $P1 y DESPUÉS la cámara la ve"
register "$P1" | json '"   ticket "+(v.data&&v.data.ticket_number)+" · validado: "+(v.data&&v.data.camera_validated_at_utc)'
camera_event "$P1" | json '"   respuesta a CAMVIEW: "+v.mensaje'

echo "== 6. Caso B: la cámara ve $P2 ANTES y el cobrador la registra después"
camera_event "$P2" | json '"   respuesta a CAMVIEW: "+v.mensaje'
register "$P2" | json '"   ticket "+(v.data&&v.data.ticket_number)+" · validado al nacer: "+(v.data&&v.data.camera_validated_at_utc)'

echo "== 7. Caso C: la cámara ve DMC$SUFFIX y nadie la registra (queda guardada sin ticket)"
camera_event "DMC$SUFFIX" | json '"   respuesta a CAMVIEW: "+v.mensaje'

echo "== 8. Estado final del trayecto #$TRIP"
curl -s -H "$AUTH" "$API/api/operations/trip/$TRIP" | json 'v.data.filter(o=>o.record_kind!=="MOTORCYCLE_BATCH").map(o=>"   "+o.normalized_plate+"  "+(o.camera_validated_at_utc?"✔ validado "+o.camera_validated_at_utc+"  foto "+o.camera_photo_path:"sin validar")).join("\n")'
curl -s -H "$AUTH" "$API/api/camview/trips/$TRIP/readings" | json '"   lecturas: "+v.data.summary.readings_total+" · placas validadas: "+v.data.summary.validated_total+" · vistas sin ticket: "+v.data.summary.unmatched_plates.join(", ")'
echo
echo "Abre http://localhost:5173/tickets?tripId=$TRIP para ver las marcas verdes y las fotos."
echo "Para borrar estos datos de prueba: bash API/scripts/limpiar-demo-camview.sh"
