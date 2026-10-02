import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DateTime } from 'luxon';
import { pool, withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { validatePlate } from '../../utils/plates.js';
import { emitToOperations } from '../../sockets/index.js';

/**
 * Validación pasiva con cámara.
 *
 * CAMVIEW envía cada placa que ve (webhook). Aquí se guarda la lectura con su
 * foto, se resuelve a qué trayecto pertenece por el ferry de la cámara y la
 * hora, y se busca un ticket de ese trayecto con la misma placa que aún no
 * tenga validación. Si existe, el ticket queda "validado con cámara". Funciona
 * en los dos sentidos: al llegar la lectura (ticket ya existe) y al registrar
 * el ticket (lectura ya existía). Nunca bloquea ni interrumpe al cobrador.
 */

const TRIP_MARGIN_MINUTES = 5;
const MAX_CROP_BYTES = 2 * 1024 * 1024;

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function generateCameraToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function isMissingSchemaError(error) {
  return error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR';
}

export async function findActiveCameraByToken(token) {
  if (!token) return null;
  const [rows] = await pool.execute(`
    SELECT cd.*, f.name AS ferry_name
    FROM camera_devices cd
    JOIN ferries f ON f.id = cd.ferry_id
    WHERE cd.token_hash = ? AND cd.active = 1
    LIMIT 1
  `, [hashToken(token)]);
  return rows[0] || null;
}

export async function touchCamera(cameraId, eventType) {
  await pool.execute(
    'UPDATE camera_devices SET last_seen_at_utc = UTC_TIMESTAMP(), last_event_type = ? WHERE id = ?',
    [String(eventType || 'unknown').slice(0, 40), cameraId]
  );
}

function toSqlUtc(value) {
  const parsed = value ? DateTime.fromISO(String(value), { setZone: true }) : null;
  const dt = parsed && parsed.isValid ? parsed.toUTC() : DateTime.utc();
  return dt.toFormat('yyyy-MM-dd HH:mm:ss');
}

function safeEventId(value) {
  const clean = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean || crypto.randomBytes(16).toString('hex');
}

async function saveCrop(base64, eventId) {
  if (!base64) return null;
  const raw = String(base64).replace(/^data:image\/\w+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch (_error) {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_CROP_BYTES) return null;
  const day = DateTime.utc().toFormat('yyyy-MM-dd');
  const folder = path.resolve(process.cwd(), env.uploadDir, 'camera', day);
  await fs.mkdir(folder, { recursive: true });
  const filename = `${eventId}.jpg`;
  await fs.writeFile(path.join(folder, filename), buffer);
  return `/uploads/camera/${day}/${filename}`;
}

async function resolveTrip(conn, ferryId, detectedAtSql) {
  const [rows] = await conn.execute(`
    SELECT t.id, t.status, t.journey_id
    FROM trips t
    WHERE t.ferry_id = ?
      AND t.deleted_at_utc IS NULL
      AND t.opened_at_utc <= DATE_ADD(?, INTERVAL ${TRIP_MARGIN_MINUTES} MINUTE)
      AND (t.closed_at_utc IS NULL OR t.closed_at_utc >= DATE_SUB(?, INTERVAL ${TRIP_MARGIN_MINUTES} MINUTE))
    ORDER BY t.opened_at_utc DESC
    LIMIT 1
  `, [ferryId, detectedAtSql, detectedAtSql]);
  return rows[0] || null;
}

async function markOperationValidated(conn, operationId, readingId, cropPath) {
  await conn.execute(`
    UPDATE operations
    SET camera_validated_at_utc = UTC_TIMESTAMP(), camera_reading_id = ?, camera_photo_path = ?
    WHERE id = ? AND camera_validated_at_utc IS NULL
  `, [readingId, cropPath || null, operationId]);
  await conn.execute('UPDATE camera_readings SET operation_id = ? WHERE id = ?', [operationId, readingId]);
}

/** Lectura nueva: busca en el trayecto un ticket con esa placa sin validar. */
async function matchReadingToOperation(conn, { tripId, plate, readingId, cropPath }) {
  const [rows] = await conn.execute(`
    SELECT id, ticket_number, invoice_number, trip_id, normalized_plate
    FROM operations
    WHERE trip_id = ? AND normalized_plate = ? AND active_in_trip = 1
      AND status NOT IN ('ANNULLED','REMOVED') AND camera_validated_at_utc IS NULL
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE
  `, [tripId, plate]);
  const operation = rows[0];
  if (!operation) return null;
  await markOperationValidated(conn, operation.id, readingId, cropPath);
  return operation;
}

/**
 * Ticket nuevo: si la cámara ya había visto esa placa en el trayecto, el
 * ticket nace validado. Nunca lanza: sin migración o sin lecturas, no hace nada.
 */
export async function attachPendingReading(conn, { tripId, plate, operationId }) {
  try {
    const [rows] = await conn.execute(`
      SELECT id, crop_path
      FROM camera_readings
      WHERE trip_id = ? AND normalized_plate = ? AND operation_id IS NULL
      ORDER BY detected_at_utc DESC
      LIMIT 1
      FOR UPDATE
    `, [tripId, plate]);
    const reading = rows[0];
    if (!reading) return null;
    await markOperationValidated(conn, operationId, reading.id, reading.crop_path);
    return reading;
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

/**
 * Un ticket retirado o anulado deja de 'poseer' sus lecturas: la placa vuelve a
 * contar como vista sin ticket y podra validar un ticket nuevo. El ticket
 * conserva su propia foto como evidencia historica. Nunca lanza.
 */
export async function releaseReadingsOfOperation(conn, operationId) {
  try {
    await conn.execute('UPDATE camera_readings SET operation_id = NULL WHERE operation_id = ?', [operationId]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }
}

export async function releaseReadingsOfTrip(conn, tripId) {
  try {
    await conn.execute('UPDATE camera_readings SET operation_id = NULL WHERE trip_id = ?', [tripId]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }
}

export async function ingestPlateEvent(camera, payload) {
  const plateCheck = validatePlate(payload.plate);
  if (!plateCheck.ok) {
    return { stored: false, message: `Placa inválida: ${String(payload.plate || '').slice(0, 20)}` };
  }
  const plate = plateCheck.normalized;
  const eventId = safeEventId(payload.event_id);
  const detectedAtSql = toSqlUtc(payload.detected_at);
  const confidence = Number(payload.confidence);

  const [existing] = await pool.execute(
    'SELECT id, operation_id, trip_id FROM camera_readings WHERE event_id = ? LIMIT 1',
    [eventId]
  );
  if (existing[0]) {
    return {
      stored: false,
      duplicate: true,
      readingId: existing[0].id,
      tripId: existing[0].trip_id,
      operationId: existing[0].operation_id,
      message: `${plate} ya recibida`
    };
  }

  const cropPath = await saveCrop(payload.crop_jpeg_base64, eventId);

  let result;
  try {
    result = await withTransaction(async (conn) => {
      const trip = await resolveTrip(conn, camera.ferry_id, detectedAtSql);
      const [insert] = await conn.execute(`
        INSERT INTO camera_readings (
          camera_id, event_id, normalized_plate, raw_text, vehicle_type, confidence, detected_at_utc, crop_path, trip_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        camera.id,
        eventId,
        plate,
        String(payload.raw_text || '').slice(0, 40) || null,
        String(payload.vehicle_type || '').slice(0, 20) || null,
        Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
        detectedAtSql,
        cropPath,
        trip?.id || null
      ]);
      const readingId = insert.insertId;
      const operation = trip
        ? await matchReadingToOperation(conn, { tripId: trip.id, plate, readingId, cropPath })
        : null;
      return { readingId, trip, operation };
    });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return { stored: false, duplicate: true, message: `${plate} ya recibida` };
    throw error;
  }

  // Toda lectura se anuncia (con o sin ticket) para que la pantalla de Operación
  // refresque la lista "vistos por la cámara sin ticket" al instante.
  emitToOperations('camera:reading', {
    reading_id: result.readingId,
    trip_id: result.trip?.id || null,
    plate,
    confidence: Number.isFinite(confidence) ? confidence : null,
    detected_at_utc: detectedAtSql,
    crop_path: cropPath,
    operation_id: result.operation?.id || null
  });
  if (result.operation) {
    emitToOperations('operation:camera_validated', {
      id: result.operation.id,
      trip_id: result.operation.trip_id,
      plate,
      camera_photo_path: cropPath,
      reading_id: result.readingId
    });
  }

  const ticket = result.operation ? (result.operation.ticket_number || result.operation.invoice_number) : null;
  let message;
  if (result.operation) message = `${plate} validada · ticket ${ticket}`;
  else if (result.trip) message = `${plate} vista · sin ticket todavía`;
  else message = `${plate} vista · sin trayecto abierto`;

  return {
    stored: true,
    readingId: result.readingId,
    tripId: result.trip?.id || null,
    operationId: result.operation?.id || null,
    message
  };
}
