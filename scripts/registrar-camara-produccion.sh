#!/usr/bin/env bash
# Registra la cámara en el API de PRODUCCIÓN, obtiene su token y lo deja configurado
# en el CAMVIEW local (webhook). Pide el usuario y la clave de un ADMIN de producción.
# Uso (Git Bash):  bash D:/Proyectos/Transdier/API/scripts/registrar-camara-produccion.sh
set -euo pipefail

API="${API_URL:-https://srv748061.hstgr.cloud/transdierv2/api}"
CAMVIEW="${CAMVIEW_URL:-http://localhost:8000}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

echo "API de producción: $API"
read -r -p "Usuario admin de producción: " ADMIN_USER
read -r -s -p "Clave: " ADMIN_PASS; echo
read -r -p "Nombre de la cámara [Rampa de cobro]: " CAM_NAME; CAM_NAME="${CAM_NAME:-Rampa de cobro}"
read -r -p "Id del ferry [1]: " FERRY_ID; FERRY_ID="${FERRY_ID:-1}"

echo "== Iniciando sesión"
LOGIN=$(curl -s -H "Content-Type: application/json" -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" "$API/auth/login")
TOKEN=$(echo "$LOGIN" | json 'v.token||""')
if [ -z "$TOKEN" ]; then echo "No se pudo iniciar sesión: $(echo "$LOGIN" | json 'v.message||"sin respuesta"')"; exit 1; fi

echo "== Registrando la cámara en producción"
CREATED=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"name\":\"$CAM_NAME\",\"ferry_id\":$FERRY_ID}" "$API/camview/cameras")
CAM_TOKEN=$(echo "$CREATED" | json 'v.data&&v.data.token||""')
if [ -z "$CAM_TOKEN" ]; then echo "No se pudo registrar: $(echo "$CREATED" | json 'v.message||"sin respuesta"')"; exit 1; fi
WEBHOOK="$API/camview/events"
echo
echo "   Cámara id:     $(echo "$CREATED" | json 'v.data.id')"
echo "   Webhook URL:   $WEBHOOK"
echo "   Webhook token: $CAM_TOKEN"
echo "   (guárdalo: el API no lo vuelve a mostrar; si se pierde se regenera con POST /camview/cameras/:id/token)"
echo

read -r -p "¿Configurar ahora el webhook en el CAMVIEW local ($CAMVIEW)? [S/n]: " APPLY
if [[ "${APPLY:-S}" =~ ^[Ss]?$ ]]; then
  CAM=$(curl -s "$CAMVIEW/api/cameras" | json 'JSON.stringify(v.cameras[0]||null)')
  if [ "$CAM" = "null" ] || [ -z "$CAM" ]; then echo "CAMVIEW no tiene cámaras configuradas o no responde."; exit 1; fi
  ID=$(echo "$CAM" | json 'v.id'); NAME=$(echo "$CAM" | json 'v.name'); HOST=$(echo "$CAM" | json 'v.host')
  USER_=$(echo "$CAM" | json 'v.user'); STREAM=$(echo "$CAM" | json 'v.stream'); CONF=$(echo "$CAM" | json 'v.min_confidence')
  GATE=$(echo "$CAM" | json 'v.gate_mode'); COOL=$(echo "$CAM" | json 'v.capture_cooldown===null?"null":v.capture_cooldown')
  curl -s -X PUT -H "Content-Type: application/json" \
    -d "{\"name\":\"$NAME\",\"host\":\"$HOST\",\"user\":\"$USER_\",\"password\":\"\",\"stream\":\"$STREAM\",\"min_confidence\":$CONF,\"webhook_url\":\"$WEBHOOK\",\"webhook_token\":\"$CAM_TOKEN\",\"include_frame\":null,\"gate_mode\":$GATE,\"capture_cooldown\":$COOL,\"enabled\":true}" \
    "$CAMVIEW/api/cameras/$ID" | json '"   CAMVIEW: "+(v.ok?"webhook guardado en la cámara "+v.camera.name:"error")'
  curl -s -X POST -H "Content-Type: application/json" -d '{"webhook_url":"","webhook_token":""}' "$CAMVIEW/api/cameras/$ID/webhook/test" | json '"   Prueba de webhook: "+v.message'
fi
echo
echo "Listo. Desde ahora cada placa que lea la cámara llega al API de producción."
