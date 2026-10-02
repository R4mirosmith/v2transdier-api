import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import {
  findActiveCameraByToken,
  generateCameraToken,
  hashToken,
  ingestPlateEvent,
  isMissingSchemaError,
  touchCamera
} from './camview.service.js';

const router = Router();

function migrationError(error) {
  if (isMissingSchemaError(error)) {
    return new AppError(
      400,
      'CAMVIEW_NEEDS_MIGRATION',
      'Falta la estructura de validación con cámara. Ejecuta database/migration_camview_validacion.sql.'
    );
  }
  return null;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

const cameraListSelect = `
  SELECT cd.id, cd.name, cd.ferry_id, f.name AS ferry_name, cd.active, cd.last_seen_at_utc, cd.last_event_type,
         cd.created_at_utc,
         TIMESTAMPDIFF(SECOND, cd.last_seen_at_utc, UTC_TIMESTAMP()) AS seconds_since_seen,
         (SELECT MAX(cr.detected_at_utc) FROM camera_readings cr WHERE cr.camera_id = cd.id) AS last_reading_at_utc,
         (SELECT TIMESTAMPDIFF(SECOND, MAX(cr.detected_at_utc), UTC_TIMESTAMP()) FROM camera_readings cr WHERE cr.camera_id = cd.id) AS seconds_since_reading,
         (SELECT cr2.normalized_plate FROM camera_readings cr2 WHERE cr2.camera_id = cd.id ORDER BY cr2.detected_at_utc DESC, cr2.id DESC LIMIT 1) AS last_plate,
         (SELECT cr4.confidence FROM camera_readings cr4 WHERE cr4.camera_id = cd.id ORDER BY cr4.detected_at_utc DESC, cr4.id DESC LIMIT 1) AS last_confidence,
         (SELECT cr5.trip_id FROM camera_readings cr5 WHERE cr5.camera_id = cd.id ORDER BY cr5.detected_at_utc DESC, cr5.id DESC LIMIT 1) AS last_trip_id,
         (SELECT o.ticket_number FROM operations o
          WHERE o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
            AND o.trip_id = (SELECT cr6.trip_id FROM camera_readings cr6 WHERE cr6.camera_id = cd.id ORDER BY cr6.detected_at_utc DESC, cr6.id DESC LIMIT 1)
            AND o.normalized_plate = (SELECT cr7.normalized_plate FROM camera_readings cr7 WHERE cr7.camera_id = cd.id ORDER BY cr7.detected_at_utc DESC, cr7.id DESC LIMIT 1)
          ORDER BY o.id DESC LIMIT 1) AS last_plate_ticket,
         (SELECT COUNT(*) FROM camera_readings cr3 WHERE cr3.camera_id = cd.id AND cr3.detected_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS readings_24h
  FROM camera_devices cd
  JOIN ferries f ON f.id = cd.ferry_id
`;

// --- Webhook de CAMVIEW: autenticado con el token de la cámara, NO con JWT ----

router.post('/events', async (req, res, next) => {
  try {
    const camera = await findActiveCameraByToken(bearerToken(req));
    if (!camera) throw new AppError(401, 'CAMERA_TOKEN_INVALID', 'Token de cámara inválido o cámara inactiva.');

    const event = req.body && typeof req.body === 'object' ? req.body : {};
    const type = String(event.event || '').toLowerCase();
    await touchCamera(camera.id, type);

    if (type === 'plate_detected') {
      const result = await ingestPlateEvent(camera, event);
      return res.json({
        ok: true,
        permitido: true,
        mensaje: result.message,
        data: {
          reading_id: result.readingId || null,
          trip_id: result.tripId || null,
          operation_id: result.operationId || null,
          duplicate: !!result.duplicate
        }
      });
    }
    if (type === 'test') {
      return res.json({
        ok: true,
        permitido: true,
        mensaje: `Cámara "${camera.name}" conectada a Transdier (${camera.ferry_name}).`
      });
    }
    res.json({ ok: true, permitido: true, mensaje: 'Evento recibido.' });
  } catch (error) { next(migrationError(error) || error); }
});

// --- Resto: usuarios autenticados ------------------------------------------

router.use(authRequired);

router.get('/status', allowRoles('ADMIN', 'CASHIER', 'OPERATOR', 'SECRETARIA'), async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`${cameraListSelect} WHERE cd.active = 1 ORDER BY cd.id`);
    res.json({
      success: true,
      data: rows.map((row) => ({ ...row, unmatched_min_confidence: env.camview.unmatchedMinConfidence }))
    });
  } catch (error) { next(migrationError(error) || error); }
});

router.get('/cameras', allowRoles('ADMIN'), async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`${cameraListSelect} ORDER BY cd.active DESC, cd.id`);
    res.json({ success: true, data: rows });
  } catch (error) { next(migrationError(error) || error); }
});

router.post('/cameras', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const ferryId = Number(req.body.ferry_id);
    if (!name || !ferryId) throw new AppError(400, 'VALIDATION_ERROR', 'Nombre y ferry son obligatorios.');
    const [ferries] = await pool.execute('SELECT id FROM ferries WHERE id = ? AND deleted_at_utc IS NULL', [ferryId]);
    if (!ferries[0]) throw new AppError(400, 'INVALID_FERRY', 'Ferry inválido.');

    const token = generateCameraToken();
    const [insert] = await pool.execute(
      'INSERT INTO camera_devices (name, ferry_id, token_hash, created_by_user_id) VALUES (?, ?, ?, ?)',
      [name, ferryId, hashToken(token), req.user.id]
    );
    res.status(201).json({
      success: true,
      message: 'Cámara registrada. Copia el token ahora: no se vuelve a mostrar.',
      data: {
        id: insert.insertId,
        name,
        ferry_id: ferryId,
        token,
        webhook_url: `${env.publicBaseUrl}/api/camview/events`
      }
    });
  } catch (error) { next(migrationError(error) || error); }
});

router.post('/cameras/:id/token', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const token = generateCameraToken();
    const [result] = await pool.execute(
      'UPDATE camera_devices SET token_hash = ? WHERE id = ?',
      [hashToken(token), req.params.id]
    );
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Cámara no encontrada.');
    res.json({
      success: true,
      message: 'Token regenerado. Actualízalo en CAMVIEW.',
      data: { id: Number(req.params.id), token, webhook_url: `${env.publicBaseUrl}/api/camview/events` }
    });
  } catch (error) { next(migrationError(error) || error); }
});

router.patch('/cameras/:id/active', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const active = req.body.active === true || req.body.active === 1 || req.body.active === '1' ? 1 : 0;
    const [result] = await pool.execute('UPDATE camera_devices SET active = ? WHERE id = ?', [active, req.params.id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Cámara no encontrada.');
    res.json({ success: true, message: active ? 'Cámara activada.' : 'Cámara desactivada.', data: { id: Number(req.params.id), active } });
  } catch (error) { next(migrationError(error) || error); }
});

// Lecturas de un trayecto: con ticket (validadas) y sin ticket (para revisión pasiva del admin).
router.get('/trips/:tripId/readings', allowRoles('ADMIN', 'CASHIER', 'OPERATOR', 'SECRETARIA'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT cr.id, cr.normalized_plate, cr.vehicle_type, cr.confidence, cr.detected_at_utc, cr.crop_path, cr.operation_id,
             o.ticket_number, o.invoice_number, cd.name AS camera_name,
             (o.id IS NOT NULL AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')) AS operation_active
      FROM camera_readings cr
      JOIN camera_devices cd ON cd.id = cr.camera_id
      LEFT JOIN operations o ON o.id = cr.operation_id
      WHERE cr.trip_id = ?
      ORDER BY cr.detected_at_utc DESC
      LIMIT 500
    `, [req.params.tripId]);

    // Validada = su ticket sigue activo. Un ticket retirado o anulado ya no cuenta.
    const validatedPlates = new Set(rows.filter((row) => Number(row.operation_active) === 1).map((row) => row.normalized_plate));
    // Placas vistas en el trayecto que NUNCA obtuvieron ticket, agrupadas (las
    // filas vienen de la más reciente a la más antigua).
    const unmatched = new Map();
    const minConfidence = env.camview.unmatchedMinConfidence;
    let lowConfidence = 0;
    for (const row of rows) {
      if (Number(row.operation_active) === 1 || validatedPlates.has(row.normalized_plate)) continue;
      if (!(Number(row.confidence) >= minConfidence)) { lowConfidence += 1; continue; }
      const current = unmatched.get(row.normalized_plate);
      if (!current) {
        unmatched.set(row.normalized_plate, {
          plate: row.normalized_plate,
          vehicle_type: row.vehicle_type,
          confidence: row.confidence,
          last_detected_at_utc: row.detected_at_utc,
          first_detected_at_utc: row.detected_at_utc,
          count: 1,
          crop_path: row.crop_path,
          camera_name: row.camera_name
        });
      } else {
        current.count += 1;
        current.first_detected_at_utc = row.detected_at_utc;
        if (!current.crop_path && row.crop_path) current.crop_path = row.crop_path;
      }
    }
    const unmatchedList = [...unmatched.values()];
    res.json({
      success: true,
      data: {
        readings: rows,
        summary: {
          readings_total: rows.length,
          plates_total: new Set(rows.map((row) => row.normalized_plate)).size,
          validated_total: validatedPlates.size,
          unmatched_total: unmatchedList.length,
          unmatched_min_confidence: minConfidence,
          unmatched_low_confidence_readings: lowConfidence,
          unmatched_plates: unmatchedList.map((item) => item.plate),
          unmatched: unmatchedList
        }
      }
    });
  } catch (error) { next(migrationError(error) || error); }
});

export default router;
