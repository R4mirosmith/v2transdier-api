import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { normalizePlate, validatePlate, validatePlateMatchesVehicleType } from '../../utils/plates.js';
import { createNotification, publishNotification } from '../notifications/notification.service.js';
import { emitToAdmins } from '../../sockets/index.js';

const router = Router();
router.use(authRequired, allowRoles('ADMIN'));

function text(value) {
  return String(value || '').trim();
}

function bool01(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

const listSelect = `
  SELECT
    v.id,
    v.normalized_plate,
    v.display_plate,
    v.vehicle_type_id,
    v.vehicle_category_id,
    v.active,
    v.created_at_utc,
    v.updated_at_utc,
    vt.name AS vehicle_type_name,
    vt.code AS vehicle_type_code,
    vc.name AS vehicle_category_name,
    vc.code AS vehicle_category_code,
    vc.plate_category,
    COALESCE(stats.operations_count, 0) AS operations_count,
    COALESCE(stats.active_operations_count, 0) AS active_operations_count,
    COALESCE(stats.total_income, 0) AS total_income,
    stats.last_operation_at_utc,
    stats.last_ticket_number,
    stats.last_route_name,
    stats.last_ferry_name,
    stats.last_driver_name,
    stats.last_driver_document,
    stats.last_driver_phone
  FROM vehicles v
  JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
  JOIN vehicle_categories vc ON vc.id = v.vehicle_category_id
  LEFT JOIN (
    SELECT
      o.vehicle_id,
      COUNT(*) AS operations_count,
      SUM(CASE WHEN o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND tr.deleted_at_utc IS NULL THEN 1 ELSE 0 END) AS active_operations_count,
      SUM(CASE WHEN o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND tr.deleted_at_utc IS NULL THEN o.fare_price ELSE 0 END) AS total_income,
      MAX(o.created_at_utc) AS last_operation_at_utc,
      SUBSTRING_INDEX(GROUP_CONCAT(o.ticket_number ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_ticket_number,
      SUBSTRING_INDEX(GROUP_CONCAT(r.name ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_route_name,
      SUBSTRING_INDEX(GROUP_CONCAT(f.name ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_ferry_name,
      SUBSTRING_INDEX(GROUP_CONCAT(o.driver_name ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_driver_name,
      SUBSTRING_INDEX(GROUP_CONCAT(o.driver_document ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_driver_document,
      SUBSTRING_INDEX(GROUP_CONCAT(o.driver_phone ORDER BY o.created_at_utc DESC SEPARATOR '||'), '||', 1) AS last_driver_phone
    FROM operations o
    JOIN trips tr ON tr.id = o.trip_id
    LEFT JOIN routes r ON r.id = tr.route_id
    LEFT JOIN ferries f ON f.id = o.ferry_id
    GROUP BY o.vehicle_id
  ) stats ON stats.vehicle_id = v.id
`;

router.get('/', async (req, res, next) => {
  try {
    const q = text(req.query.q || req.query.search).toUpperCase();
    const includeInactive = req.query.all === '1' || req.query.includeInactive === '1';
    const params = [];
    const where = [];
    if (!includeInactive) where.push('v.active = 1');
    if (q) {
      const like = `%${q}%`;
      where.push(`(v.normalized_plate LIKE ? OR v.display_plate LIKE ? OR vt.name LIKE ? OR vc.name LIKE ? OR stats.last_driver_name LIKE ? OR stats.last_driver_document LIKE ?)`);
      params.push(like, like, like, like, like, like);
    }
    const [rows] = await pool.execute(`
      ${listSelect}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY v.active DESC, COALESCE(stats.last_operation_at_utc, v.created_at_utc) DESC, v.id DESC
      LIMIT 500
    `, params);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  let notification;
  try {
    const result = await withTransaction(async (conn) => {
      const plateCheck = validatePlate(req.body.display_plate || req.body.normalized_plate);
      if (!plateCheck.ok) throw new AppError(400, 'INVALID_PLATE', plateCheck.message);

      const normalizedPlate = plateCheck.normalized;
      const displayPlate = text(req.body.display_plate || normalizedPlate).toUpperCase();
      const vehicleTypeId = Number(req.body.vehicle_type_id);
      const active = bool01(req.body.active ?? 1);

      if (!Number.isInteger(vehicleTypeId) || vehicleTypeId <= 0) {
        throw new AppError(400, 'INVALID_VEHICLE_TYPE', 'Selecciona un tipo de vehículo válido.');
      }

      const [typeRows] = await conn.execute(`
        SELECT
          vt.*,
          vc.name AS vehicle_category_name,
          vc.code AS vehicle_category_code,
          vc.plate_category
        FROM vehicle_types vt
        JOIN vehicle_categories vc ON vc.id = vt.vehicle_category_id
        WHERE vt.id = ?
          AND vt.active = 1
          AND vc.active = 1
          AND vt.category_review_required = 0
        LIMIT 1
      `, [vehicleTypeId]);
      const vehicleType = typeRows[0];
      if (!vehicleType) {
        throw new AppError(400, 'INVALID_VEHICLE_TYPE', 'Tipo de vehículo inválido, inactivo o pendiente de clasificación.');
      }

      const plateTypeCheck = validatePlateMatchesVehicleType(normalizedPlate, vehicleType);
      if (!plateTypeCheck.ok) throw new AppError(400, 'PLATE_TYPE_MISMATCH', plateTypeCheck.message);

      const [duplicates] = await conn.execute(
        'SELECT id, active FROM vehicles WHERE normalized_plate = ? LIMIT 1 FOR UPDATE',
        [normalizedPlate]
      );
      if (duplicates.length) {
        throw new AppError(
          409,
          'PLATE_EXISTS',
          `La placa ${normalizedPlate} ya está registrada${Number(duplicates[0].active) === 0 ? ' y se encuentra inactiva. Puedes activarla desde el listado' : ''}.`
        );
      }

      const [insertResult] = await conn.execute(
        `INSERT INTO vehicles (
          normalized_plate, display_plate, vehicle_type_id, vehicle_category_id, active
        ) VALUES (?, ?, ?, ?, ?)`,
        [normalizedPlate, displayPlate, vehicleTypeId, vehicleType.vehicle_category_id, active]
      );

      const created = {
        id: insertResult.insertId,
        normalized_plate: normalizedPlate,
        display_plate: displayPlate,
        vehicle_type_id: vehicleTypeId,
        vehicle_type_name: vehicleType.name,
        vehicle_category_id: vehicleType.vehicle_category_id,
        vehicle_category_name: vehicleType.vehicle_category_name,
        active
      };

      notification = await createNotification(conn, {
        type: 'vehicle:admin_created',
        severity: 'SUCCESS',
        title: 'Vehículo registrado',
        message: `${req.user.name} registró la placa ${normalizedPlate} como ${vehicleType.name}.`,
        payload: created
      });

      return created;
    });

    publishNotification(notification);
    emitToAdmins('vehicle:created', result);
    res.status(201).json({ success: true, message: 'Vehículo registrado correctamente.', data: result });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return next(new AppError(409, 'PLATE_EXISTS', 'Ya existe un vehículo registrado con esa placa.'));
    }
    next(error);
  }
});

router.get('/:id/history', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        o.id,
        o.ticket_number,
        o.normalized_plate,
        o.display_plate,
        o.driver_name,
        o.driver_document,
        o.driver_phone,
        o.load_status,
        o.fare_price,
        o.status,
        o.active_in_trip,
        o.created_at_utc,
        vt.name AS vehicle_type_name,
        vc.name AS vehicle_category_name,
        vc.code AS vehicle_category_code,
        r.name AS route_name,
        f.name AS ferry_name,
        j.opened_at_utc AS journey_opened_at_utc,
        rb.name AS registered_by_name,
        bb.name AS billed_by_name
      FROM operations o
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      JOIN trips t ON t.id = o.trip_id
      JOIN routes r ON r.id = t.route_id
      JOIN ferries f ON f.id = o.ferry_id
      JOIN journeys j ON j.id = o.journey_id
      JOIN users rb ON rb.id = o.registered_by_user_id
      JOIN users bb ON bb.id = o.billed_by_user_id
      WHERE o.vehicle_id = ?
      ORDER BY o.created_at_utc DESC
      LIMIT 300
    `, [req.params.id]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  let notification;
  try {
    const result = await withTransaction(async (conn) => {
      const [vehicleRows] = await conn.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [req.params.id]);
      const current = vehicleRows[0];
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Vehículo no encontrado.');

      const plateCheck = validatePlate(req.body.display_plate || req.body.normalized_plate || current.display_plate);
      if (!plateCheck.ok) throw new AppError(400, 'INVALID_PLATE', plateCheck.message);
      const normalizedPlate = plateCheck.normalized;
      const displayPlate = text(req.body.display_plate || normalizedPlate).toUpperCase();
      const vehicleTypeId = Number(req.body.vehicle_type_id || current.vehicle_type_id);
      const active = bool01(req.body.active ?? current.active);
      const syncOperations = req.body.sync_operations === undefined ? false : !!req.body.sync_operations;

      const [typeRows] = await conn.execute(`
        SELECT
          vt.*,
          vc.name AS vehicle_category_name,
          vc.code AS vehicle_category_code,
          vc.plate_category
        FROM vehicle_types vt
        JOIN vehicle_categories vc ON vc.id = vt.vehicle_category_id
        WHERE vt.id = ?
          AND vt.category_review_required = 0
        LIMIT 1
      `, [vehicleTypeId]);
      const vehicleType = typeRows[0];
      if (!vehicleType) throw new AppError(400, 'INVALID_VEHICLE_TYPE', 'Tipo de vehículo inválido o pendiente de clasificación.');

      const plateTypeCheck = validatePlateMatchesVehicleType(normalizedPlate, vehicleType);
      if (!plateTypeCheck.ok) throw new AppError(400, 'PLATE_TYPE_MISMATCH', plateTypeCheck.message);

      const [duplicateVehicles] = await conn.execute('SELECT id FROM vehicles WHERE normalized_plate = ? AND id <> ? LIMIT 1', [normalizedPlate, current.id]);
      if (duplicateVehicles.length) throw new AppError(409, 'PLATE_EXISTS', `Ya existe otro vehículo con la placa ${normalizedPlate}.`);

      if (syncOperations) {
        const [conflicts] = await conn.execute(`
          SELECT o.trip_id
          FROM operations o
          JOIN operations other
            ON other.trip_id = o.trip_id
           AND other.normalized_plate = ?
           AND other.vehicle_id <> o.vehicle_id
           AND other.active_in_trip = 1
           AND other.status NOT IN ('ANNULLED','REMOVED')
          WHERE o.vehicle_id = ?
            AND o.active_in_trip = 1
            AND o.status NOT IN ('ANNULLED','REMOVED')
          LIMIT 1
        `, [normalizedPlate, current.id]);
        if (conflicts.length) throw new AppError(409, 'PLATE_CONFLICT_IN_TRIP', `La placa ${normalizedPlate} ya existe en uno de los trayectos de este vehículo.`);
      }

      await conn.execute(
        `UPDATE vehicles
         SET normalized_plate = ?, display_plate = ?, vehicle_type_id = ?, vehicle_category_id = ?,
             active = ?, updated_at_utc = UTC_TIMESTAMP()
         WHERE id = ?`,
        [normalizedPlate, displayPlate, vehicleTypeId, vehicleType.vehicle_category_id, active, current.id]
      );

      let affectedOperations = 0;
      if (syncOperations) {
        const [updateOps] = await conn.execute(
          `UPDATE operations
             SET normalized_plate = ?, display_plate = ?, vehicle_type_id = ?, vehicle_category_id = ?
           WHERE vehicle_id = ?`,
          [normalizedPlate, displayPlate, vehicleTypeId, vehicleType.vehicle_category_id, current.id]
        );
        affectedOperations = updateOps.affectedRows || 0;
        await conn.execute(
          `INSERT INTO operation_events (operation_id, event_type, user_id, details_json)
           SELECT id, 'VEHICLE_ADMIN_UPDATED', ?, ?
           FROM operations WHERE vehicle_id = ?`,
          [req.user.id, JSON.stringify({
            from: {
              normalized_plate: current.normalized_plate,
              display_plate: current.display_plate,
              vehicle_type_id: current.vehicle_type_id,
              vehicle_category_id: current.vehicle_category_id,
              active: current.active
            },
            to: {
              normalized_plate: normalizedPlate,
              display_plate: displayPlate,
              vehicle_type_id: vehicleTypeId,
              vehicle_category_id: vehicleType.vehicle_category_id,
              active
            },
            affected_operations: affectedOperations
          }), current.id]
        );
      }

      notification = await createNotification(conn, {
        type: 'vehicle:admin_updated',
        severity: 'INFO',
        title: 'Vehículo editado',
        message: `${req.user.name} editó la placa ${current.normalized_plate} → ${normalizedPlate}.`,
        payload: { vehicle_id: current.id, normalized_plate: normalizedPlate, affected_operations: affectedOperations }
      });

      return {
        id: current.id,
        normalized_plate: normalizedPlate,
        display_plate: displayPlate,
        vehicle_type_id: vehicleTypeId,
        vehicle_category_id: vehicleType.vehicle_category_id,
        vehicle_category_name: vehicleType.vehicle_category_name,
        active,
        affected_operations: affectedOperations
      };
    });
    publishNotification(notification);
    emitToAdmins('vehicle:updated', result);
    res.json({ success: true, message: 'Vehículo actualizado correctamente.', data: result });
  } catch (error) { next(error); }
});

router.patch('/:id/active', async (req, res, next) => {
  let notification;
  try {
    const active = bool01(req.body.active);
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM vehicles WHERE id = ? FOR UPDATE', [req.params.id]);
      const vehicle = rows[0];
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehículo no encontrado.');
      await conn.execute('UPDATE vehicles SET active = ?, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [active, vehicle.id]);
      notification = await createNotification(conn, {
        type: 'vehicle:active_changed',
        severity: active ? 'SUCCESS' : 'WARNING',
        title: active ? 'Vehículo activado' : 'Vehículo desactivado',
        message: `${req.user.name} ${active ? 'activó' : 'desactivó'} la placa ${vehicle.normalized_plate}.`,
        payload: { vehicle_id: vehicle.id, normalized_plate: vehicle.normalized_plate, active }
      });
      return { id: vehicle.id, active };
    });
    publishNotification(notification);
    emitToAdmins('vehicle:active_changed', result);
    res.json({ success: true, message: active ? 'Vehículo activado correctamente.' : 'Vehículo desactivado correctamente.', data: result });
  } catch (error) { next(error); }
});

export default router;
