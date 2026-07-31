import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, publishNotification } from './notification.service.js';
import { emitToAdmins, emitToUser } from '../../sockets/index.js';

const router = Router();
router.use(authRequired);

function parsePayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function mapNotification(row) {
  const payload = parsePayload(row.payload_json) || {};
  if (row.restriction_request_id) {
    payload.restriction_request_id = row.restriction_request_id;
    payload.restriction_request_status = row.restriction_request_status;
    payload.restriction_request_resolved_at_utc = row.restriction_request_resolved_at_utc;
    payload.restriction_request_resolved_by_name = row.restriction_request_resolved_by_name;
  }

  const { payload_json: _payloadJson, ...notification } = row;
  return { ...notification, payload };
}

function migrationErrorIfNeeded(error) {
  if (
    error?.code === 'ER_NO_SUCH_TABLE'
    && String(error?.message || '').includes('restricted_vehicle_registration_requests')
  ) {
    return new AppError(
      400,
      'RESTRICTED_VEHICLE_REQUESTS_NEED_MIGRATION',
      'Falta la tabla de autorizaciones de vehículos restringidos. Ejecuta database/migration_autorizacion_vehiculos_restringidos.sql.'
    );
  }
  return null;
}

router.get('/', allowRoles('ADMIN'), async (_req, res, next) => {
  try {
    let rows;
    try {
      [rows] = await pool.execute(`
        SELECT
          n.*,
          rr.id AS restriction_request_id,
          rr.status AS restriction_request_status,
          rr.resolved_at_utc AS restriction_request_resolved_at_utc,
          resolver.name AS restriction_request_resolved_by_name
        FROM notifications n
        LEFT JOIN restricted_vehicle_registration_requests rr ON rr.notification_id = n.id
        LEFT JOIN users resolver ON resolver.id = rr.resolved_by_user_id
        WHERE n.user_id IS NULL
        ORDER BY n.id DESC
        LIMIT 100
      `);
    } catch (error) {
      if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
      [rows] = await pool.execute(`
        SELECT * FROM notifications
        WHERE user_id IS NULL
        ORDER BY id DESC LIMIT 100
      `);
    }

    res.json({ success: true, data: rows.map(mapNotification) });
  } catch (error) { next(error); }
});

router.post('/restricted-vehicle-requests/:id/allow', allowRoles('ADMIN'), async (req, res, next) => {
  let requesterNotification = null;
  try {
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(`
        SELECT
          rr.*,
          vt.name AS vehicle_type_name,
          requester.name AS requested_by_name
        FROM restricted_vehicle_registration_requests rr
        JOIN vehicle_types vt ON vt.id = rr.vehicle_type_id
        JOIN users requester ON requester.id = rr.requested_by_user_id
        WHERE rr.id = ?
        LIMIT 1
        FOR UPDATE
      `, [req.params.id]);

      const request = rows[0];
      if (!request) throw new AppError(404, 'NOT_FOUND', 'Solicitud de autorización no encontrada.');

      if (request.status === 'APPROVED') {
        return {
          request_id: request.id,
          status: 'APPROVED',
          plate: request.normalized_plate,
          vehicle_type_id: request.vehicle_type_id,
          vehicle_type_name: request.vehicle_type_name,
          trip_id: request.trip_id,
          requested_by_user_id: request.requested_by_user_id,
          requested_by_name: request.requested_by_name,
          vehicle_id: request.approved_vehicle_id,
          already_approved: true
        };
      }

      if (request.status !== 'PENDING') {
        throw new AppError(409, 'REQUEST_NOT_PENDING', 'Esta solicitud ya no está pendiente.');
      }

      const [vehicleRows] = await conn.execute(
        'SELECT * FROM vehicles WHERE normalized_plate = ? FOR UPDATE',
        [request.normalized_plate]
      );
      const existingVehicle = vehicleRows[0];

      if (existingVehicle && Number(existingVehicle.vehicle_type_id) !== Number(request.vehicle_type_id)) {
        throw new AppError(
          409,
          'VEHICLE_TYPE_CONFLICT',
          `La placa ${request.normalized_plate} ya existe con otro tipo de vehículo.`
        );
      }

      let vehicleId = existingVehicle?.id || null;
      if (!vehicleId) {
        const [insertVehicle] = await conn.execute(
          'INSERT INTO vehicles (normalized_plate, display_plate, vehicle_type_id) VALUES (?, ?, ?)',
          [request.normalized_plate, request.display_plate, request.vehicle_type_id]
        );
        vehicleId = insertVehicle.insertId;
      }

      await conn.execute(`
        UPDATE restricted_vehicle_registration_requests
        SET status = 'APPROVED',
            approved_vehicle_id = ?,
            resolved_by_user_id = ?,
            resolved_at_utc = UTC_TIMESTAMP()
        WHERE id = ?
      `, [vehicleId, req.user.id, request.id]);

      if (request.notification_id) {
        await conn.execute(
          'UPDATE notifications SET read_at_utc = COALESCE(read_at_utc, UTC_TIMESTAMP()) WHERE id = ?',
          [request.notification_id]
        );
      }

      requesterNotification = await createNotification(conn, {
        type: 'vehicle:restriction_approved',
        severity: 'SUCCESS',
        title: 'Vehículo autorizado',
        message: `${req.user.name} autorizó la placa ${request.normalized_plate}. Ya puedes registrarla en el trayecto.`,
        user_id: request.requested_by_user_id,
        payload: {
          restriction_request_id: request.id,
          restriction_request_status: 'APPROVED',
          plate: request.normalized_plate,
          display_plate: request.display_plate,
          vehicle_id: vehicleId,
          vehicle_type_id: request.vehicle_type_id,
          vehicle_type_name: request.vehicle_type_name,
          trip_id: request.trip_id,
          approved_by_user_id: req.user.id,
          approved_by_name: req.user.name
        }
      });

      return {
        request_id: request.id,
        status: 'APPROVED',
        plate: request.normalized_plate,
        display_plate: request.display_plate,
        vehicle_id: vehicleId,
        vehicle_type_id: request.vehicle_type_id,
        vehicle_type_name: request.vehicle_type_name,
        trip_id: request.trip_id,
        requested_by_user_id: request.requested_by_user_id,
        requested_by_name: request.requested_by_name,
        approved_by_user_id: req.user.id,
        approved_by_name: req.user.name,
        already_approved: false
      };
    });

    if (requesterNotification) publishNotification(requesterNotification);
    emitToUser(result.requested_by_user_id, 'vehicle:restriction_approved', result);
    emitToAdmins('vehicle:restriction_approved', result);

    res.json({
      success: true,
      message: result.already_approved
        ? `La placa ${result.plate} ya estaba autorizada.`
        : `La placa ${result.plate} fue autorizada sin desactivar la restricción del tipo ${result.vehicle_type_name}.`,
      data: result
    });
  } catch (error) {
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    if (error?.code === 'ER_DUP_ENTRY') {
      return next(new AppError(409, 'PLATE_EXISTS', 'La placa ya fue autorizada o registrada por otro administrador.'));
    }
    next(error);
  }
});

router.post('/:id/read', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    await pool.execute('UPDATE notifications SET read_at_utc = UTC_TIMESTAMP() WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Notificación marcada como leída.' });
  } catch (error) { next(error); }
});

export default router;
