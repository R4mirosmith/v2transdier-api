import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, publishNotification } from './notification.service.js';
import { emitToAdmins, emitToUser } from '../../sockets/index.js';
import {
  getPushPublicConfig,
  removePushSubscription,
  savePushSubscription,
  sendPushNotification
} from './push.service.js';

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

  const {
    payload_json: _payloadJson,
    user_read_at_utc: userReadAtUtc,
    ...notification
  } = row;
  return {
    ...notification,
    read_at_utc: notification.user_id ? notification.read_at_utc : (userReadAtUtc || null),
    payload
  };
}

function migrationErrorIfNeeded(error) {
  const message = String(error?.message || '');
  if (
    error?.code === 'ER_NO_SUCH_TABLE'
    && (message.includes('notification_reads') || message.includes('push_subscriptions'))
  ) {
    return new AppError(
      400,
      'PWA_NOTIFICATIONS_NEED_MIGRATION',
      'Falta la estructura de notificaciones PWA. Ejecuta database/migration_notificaciones_push_pwa.sql.'
    );
  }
  if (
    error?.code === 'ER_NO_SUCH_TABLE'
    && message.includes('restricted_vehicle_registration_requests')
  ) {
    return new AppError(
      400,
      'RESTRICTED_VEHICLE_REQUESTS_NEED_MIGRATION',
      'Falta la tabla de autorizaciones de vehículos restringidos. Ejecuta database/migration_autorizacion_vehiculos_restringidos.sql.'
    );
  }
  if (
    (error?.code === 'ER_NO_SUCH_TABLE' && message.includes('vehicle_categories'))
    || (error?.code === 'ER_BAD_FIELD_ERROR' && message.includes('vehicle_category_id'))
  ) {
    return new AppError(
      400,
      'VEHICLE_CATEGORIES_NEED_MIGRATION',
      'La base de datos aún no tiene categorías reales de vehículos. Ejecuta database/migration_categorias_reales_vehiculos.sql.'
    );
  }
  return null;
}


router.get('/unread-count', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM restricted_vehicle_registration_requests
      WHERE status = 'PENDING'
    `);
    res.json({ success: true, data: { count: Number(rows[0]?.total || 0) } });
  } catch (error) { next(migrationErrorIfNeeded(error) || error); }
});

router.get('/pending', allowRoles('ADMIN'), async (_req, res, next) => {
  try {
    const [[rows], [countRows]] = await Promise.all([
      pool.execute(`
        SELECT
          n.*,
          NULL AS user_read_at_utc,
          rr.id AS restriction_request_id,
          rr.status AS restriction_request_status,
          rr.resolved_at_utc AS restriction_request_resolved_at_utc,
          resolver.name AS restriction_request_resolved_by_name
        FROM restricted_vehicle_registration_requests rr
        JOIN notifications n ON n.id = rr.notification_id
        LEFT JOIN users resolver ON resolver.id = rr.resolved_by_user_id
        WHERE rr.status = 'PENDING'
        ORDER BY n.id DESC
        LIMIT 50
      `),
      pool.execute(`
        SELECT COUNT(*) AS total
        FROM restricted_vehicle_registration_requests
        WHERE status = 'PENDING'
      `)
    ]);
    const notifications = rows.map(mapNotification);
    res.json({
      success: true,
      data: {
        count: Number(countRows[0]?.total || 0),
        notifications
      }
    });
  } catch (error) { next(migrationErrorIfNeeded(error) || error); }
});

router.post('/read-all', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const [result] = await pool.execute(`
      INSERT IGNORE INTO notification_reads (notification_id, user_id, read_at_utc)
      SELECT n.id, ?, UTC_TIMESTAMP()
      FROM notifications n
      WHERE n.user_id IS NULL
    `, [req.user.id]);
    res.json({
      success: true,
      message: 'Notificaciones marcadas como vistas.',
      data: { updated: Number(result.affectedRows || 0) }
    });
  } catch (error) { next(migrationErrorIfNeeded(error) || error); }
});

router.get('/push/config', allowRoles('ADMIN', 'CASHIER', 'OPERATOR'), (_req, res) => {
  res.json({ success: true, data: getPushPublicConfig() });
});

router.post('/push/subscribe', allowRoles('ADMIN', 'CASHIER', 'OPERATOR'), async (req, res, next) => {
  try {
    const config = getPushPublicConfig();
    if (!config.enabled) {
      throw new AppError(
        503,
        'WEB_PUSH_NOT_CONFIGURED',
        'Las notificaciones push aún no tienen configuradas las claves VAPID en el servidor.'
      );
    }

    await savePushSubscription(req.user.id, req.body?.subscription, req.headers['user-agent']);
    res.json({ success: true, message: 'Alertas del dispositivo activadas correctamente.' });
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return next(new AppError(
        400,
        'PUSH_SUBSCRIPTIONS_NEED_MIGRATION',
        'Falta la tabla de suscripciones push. Ejecuta database/migration_notificaciones_push_pwa.sql.'
      ));
    }
    if (error?.code === 'INVALID_PUSH_SUBSCRIPTION') {
      return next(new AppError(400, error.code, error.message));
    }
    next(error);
  }
});

router.post('/push/unsubscribe', allowRoles('ADMIN', 'CASHIER', 'OPERATOR'), async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint) throw new AppError(400, 'VALIDATION_ERROR', 'El endpoint de la suscripción es obligatorio.');
    await removePushSubscription(req.user.id, endpoint);
    res.json({ success: true, message: 'Alertas de este dispositivo desactivadas.' });
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return next(new AppError(
        400,
        'PUSH_SUBSCRIPTIONS_NEED_MIGRATION',
        'Falta la tabla de suscripciones push. Ejecuta database/migration_notificaciones_push_pwa.sql.'
      ));
    }
    next(error);
  }
});

router.post('/push/test', allowRoles('ADMIN', 'CASHIER', 'OPERATOR'), async (req, res, next) => {
  try {
    const notification = {
      id: `test-${Date.now()}`,
      type: 'push:test',
      severity: 'WARNING',
      title: 'Prueba de alertas Transdier',
      message: 'Las notificaciones de este dispositivo están funcionando correctamente.',
      user_id: req.user.id,
      payload: { test: true, url: req.user.role === 'ADMIN' ? '/notificaciones' : '/tickets' }
    };
    const result = await sendPushNotification(notification, { force: true });
    if (!result.enabled) {
      throw new AppError(503, 'WEB_PUSH_NOT_CONFIGURED', 'Las claves VAPID no están configuradas en el servidor.');
    }
    res.json({
      success: true,
      message: result.sent > 0 ? 'Notificación de prueba enviada.' : 'No hay una suscripción activa para este dispositivo.',
      data: result
    });
  } catch (error) { next(error); }
});

router.get('/', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    let rows;
    try {
      [rows] = await pool.execute(`
        SELECT
          n.*,
          nr.read_at_utc AS user_read_at_utc,
          rr.id AS restriction_request_id,
          rr.status AS restriction_request_status,
          rr.resolved_at_utc AS restriction_request_resolved_at_utc,
          resolver.name AS restriction_request_resolved_by_name
        FROM notifications n
        LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
        LEFT JOIN restricted_vehicle_registration_requests rr ON rr.notification_id = n.id
        LEFT JOIN users resolver ON resolver.id = rr.resolved_by_user_id
        WHERE n.user_id IS NULL
        ORDER BY n.id DESC
        LIMIT 100
      `, [req.user.id]);
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
          rr.vehicle_category_id,
          vc.name AS vehicle_category_name,
          vc.code AS vehicle_category_code,
          vc.plate_category,
          requester.name AS requested_by_name
        FROM restricted_vehicle_registration_requests rr
        JOIN vehicle_types vt ON vt.id = rr.vehicle_type_id
        JOIN vehicle_categories vc ON vc.id = rr.vehicle_category_id
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
          vehicle_category_id: request.vehicle_category_id,
          vehicle_category_name: request.vehicle_category_name,
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

      if (existingVehicle && Number(existingVehicle.vehicle_category_id) !== Number(request.vehicle_category_id)) {
        throw new AppError(
          409,
          'VEHICLE_CATEGORY_CONFLICT',
          `La placa ${request.normalized_plate} ya existe con una categoría real diferente.`
        );
      }

      let vehicleId = existingVehicle?.id || null;
      if (!vehicleId) {
        const [insertVehicle] = await conn.execute(
          `INSERT INTO vehicles (
            normalized_plate, display_plate, vehicle_type_id, vehicle_category_id
          ) VALUES (?, ?, ?, ?)`,
          [request.normalized_plate, request.display_plate, request.vehicle_type_id, request.vehicle_category_id]
        );
        vehicleId = insertVehicle.insertId;
      } else {
        await conn.execute(
          'UPDATE vehicles SET vehicle_type_id = ?, vehicle_category_id = ?, active = 1, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?',
          [request.vehicle_type_id, request.vehicle_category_id, vehicleId]
        );
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
        await conn.execute(`
          INSERT INTO notification_reads (notification_id, user_id, read_at_utc)
          VALUES (?, ?, UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE read_at_utc = VALUES(read_at_utc)
        `, [request.notification_id, req.user.id]);
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
          vehicle_category_id: request.vehicle_category_id,
          vehicle_category_name: request.vehicle_category_name,
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
        vehicle_category_id: request.vehicle_category_id,
        vehicle_category_name: request.vehicle_category_name,
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
    await pool.execute(`
      INSERT INTO notification_reads (notification_id, user_id, read_at_utc)
      VALUES (?, ?, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE read_at_utc = VALUES(read_at_utc)
    `, [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Notificación marcada como leída.' });
  } catch (error) { next(migrationErrorIfNeeded(error) || error); }
});

export default router;
