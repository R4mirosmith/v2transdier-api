import { Router } from 'express';
import path from 'path';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { upload, setUploadFolder } from '../../middlewares/upload.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, publishNotification } from '../notifications/notification.service.js';
import { emitToOperations } from '../../sockets/index.js';
import { sendHtmlTableExport } from '../../utils/exporters.js';

const router = Router();
router.use(authRequired);

function filePathForDb(file, folder) {
  if (!file) return null;
  return `/uploads/${folder}/${path.basename(file.path)}`;
}

function tripIncomeExpression(alias = 'o') {
  return `COALESCE(SUM(CASE WHEN ${alias}.active_in_trip = 1 AND ${alias}.status IN ('PAID','BOARDED') AND ${alias}.payment_method = 'CASH' THEN ${alias}.fare_price ELSE 0 END), 0)`;
}

router.get('/open', async (req, res, next) => {
  try {
    const tripId = Number(req.query.trip_id || 0);
    const params = [];
    let where = "t.status = 'OPEN' AND j.status = 'OPEN' AND t.deleted_at_utc IS NULL";
    if (req.user.role === 'ADMIN' && tripId) {
      where = "((t.status = 'OPEN' AND j.status = 'OPEN') OR (t.id = ? AND t.status = 'CLOSED')) AND t.deleted_at_utc IS NULL";
      params.push(tripId);
    }
    const [rows] = await pool.execute(`
      SELECT t.*, r.name AS route_name, r.origin_name, r.destination_name, j.ferry_id, j.status AS journey_status, f.name AS ferry_name, c.business_name AS company_name,
        ou.name AS opened_by_name,
        ${tripIncomeExpression('o')} AS income_total,
        COUNT(o.id) AS operations_total
      FROM trips t
      JOIN journeys j ON j.id = t.journey_id
      JOIN ferries f ON f.id = j.ferry_id
      JOIN companies c ON c.id = j.company_id
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN operations o ON o.trip_id = t.id AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
      WHERE ${where}
      GROUP BY t.id
      ORDER BY FIELD(t.id, ? ) DESC, t.id DESC
    `, [...params, tripId]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});


router.get('/ferry/:ferryId/next-route', async (req, res, next) => {
  try {
    const ferryId = Number(req.params.ferryId);
    const journeyId = Number(req.query.journey_id || 0);
    if (!ferryId) throw new AppError(400, 'FERRY_REQUIRED', 'Ferry requerido.');

    const [openRows] = await pool.execute(`
      SELECT t.id, t.journey_id, t.route_id, r.name AS route_name, t.opened_at_utc
      FROM trips t
      JOIN routes r ON r.id = t.route_id
      WHERE t.ferry_id = ? AND t.status = 'OPEN' AND t.deleted_at_utc IS NULL
      ORDER BY t.id DESC
      LIMIT 1
    `, [ferryId]);

    const lastClosedParams = [ferryId];
    let lastClosedJourneyFilter = '';
    if (journeyId) {
      lastClosedJourneyFilter = ' AND t.journey_id = ?';
      lastClosedParams.push(journeyId);
    }

    const [lastClosedRows] = await pool.execute(`
      SELECT t.id, t.journey_id, t.route_id, r.name AS route_name, r.origin_name, r.destination_name, t.closed_at_utc
      FROM trips t
      JOIN routes r ON r.id = t.route_id
      WHERE t.ferry_id = ? AND t.status = 'CLOSED' AND t.deleted_at_utc IS NULL${lastClosedJourneyFilter}
      ORDER BY COALESCE(t.closed_at_utc, t.opened_at_utc) DESC, t.id DESC
      LIMIT 1
    `, lastClosedParams);

    const lastClosed = lastClosedRows[0] || null;
    let nextRoute = null;
    if (lastClosed) {
      const [nextRows] = await pool.execute(`
        SELECT id, name, origin_name, destination_name
        FROM routes
        WHERE active = 1 AND origin_name = ? AND destination_name = ?
        LIMIT 1
      `, [lastClosed.destination_name, lastClosed.origin_name]);
      nextRoute = nextRows[0] || null;
    }

    res.json({
      success: true,
      data: {
        has_open_trip: !!openRows[0],
        open_trip: openRows[0] || null,
        last_closed_trip: lastClosed,
        next_route: nextRoute,
        next_route_id: nextRoute?.id || null,
        next_route_name: nextRoute?.name || null
      }
    });
  } catch (error) { next(error); }
});

router.get('/export', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const journeyId = Number(req.query.journey_id);
    if (!journeyId) throw new AppError(400, 'JOURNEY_REQUIRED', 'Debes seleccionar una jornada para exportar.');
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';

    const [rows] = await pool.execute(`
      SELECT
        j.id AS journey_id, j.opened_at_utc AS journey_opened_at_utc, j.status AS journey_status,
        c.business_name AS company_name, f.name AS ferry_name,
        t.id AS trip_id, t.status AS trip_status, t.opened_at_utc AS trip_opened_at_utc, t.closed_at_utc AS trip_closed_at_utc,
        r.name AS route_name,
        ou.name AS trip_opened_by_name,
        cu.name AS trip_closed_by_name,
        du.name AS trip_deleted_by_name,
        t.delete_reason,
        o.id AS operation_id, o.ticket_number, o.invoice_number, o.normalized_plate,
        vt.name AS vehicle_type_name,
        o.vehicle_category_id,
        vc.code AS vehicle_category_code,
        vc.name AS vehicle_category_name,
        o.load_status, o.fare_price, o.payment_method, o.status AS operation_status,
        o.active_in_trip, o.created_at_utc AS operation_created_at_utc,
        rb.name AS registered_by_name,
        bb.name AS billed_by_name,
        rem.name AS removed_by_name,
        o.removed_from_trip_reason
      FROM trips t
      JOIN journeys j ON j.id = t.journey_id
      JOIN companies c ON c.id = t.company_id
      JOIN ferries f ON f.id = t.ferry_id
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN users cu ON cu.id = t.closed_by_user_id
      LEFT JOIN users du ON du.id = t.deleted_by_user_id
      LEFT JOIN operations o ON o.trip_id = t.id AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
      LEFT JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      LEFT JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      LEFT JOIN users rb ON rb.id = o.registered_by_user_id
      LEFT JOIN users bb ON bb.id = o.billed_by_user_id
      LEFT JOIN users rem ON rem.id = o.removed_from_trip_by_user_id
      WHERE t.journey_id = ? AND t.deleted_at_utc IS NULL
      ORDER BY t.id DESC, o.id DESC
    `, [journeyId]);

    sendHtmlTableExport(res, {
      filename: `transdier-trayectos-jornada-${journeyId}`,
      format,
      title: `Detalle de trayectos - Jornada ${journeyId}`,
      rows,
      columns: [
        { header: 'Jornada', key: 'journey_id' },
        { header: 'Empresa', key: 'company_name' },
        { header: 'Ferry', key: 'ferry_name' },
        { header: 'ID Trayecto', key: 'trip_id' },
        { header: 'Trayecto', key: 'route_name' },
        { header: 'Estado trayecto', key: 'trip_status' },
        { header: 'Abrió trayecto', key: 'trip_opened_by_name' },
        { header: 'Cerró trayecto', key: 'trip_closed_by_name' },
        { header: 'Ticket', value: r => r.ticket_number || r.invoice_number || '' },
        { header: 'Placa', key: 'normalized_plate' },
        { header: 'Categoría real', key: 'vehicle_category_name' },
        { header: 'Tipo / tarifa comercial', key: 'vehicle_type_name' },
        { header: 'Condición', key: 'load_status' },
        { header: 'Valor', key: 'fare_price' },
        { header: 'Estado ticket', key: 'operation_status' },
        { header: 'Activo en trayecto', value: r => r.operation_id ? (Number(r.active_in_trip) ? 'Sí' : 'No / retirado') : '' },
        { header: 'Registró vehículo', key: 'registered_by_name' },
        { header: 'Facturó ticket', key: 'billed_by_name' },
        { header: 'Retiró vehículo', key: 'removed_by_name' },
        { header: 'Motivo retiro', key: 'removed_from_trip_reason' },
        { header: 'Fecha registro UTC', key: 'operation_created_at_utc' }
      ]
    });
  } catch (error) { next(error); }
});

router.get('/journey/:journeyId/detail', async (req, res, next) => {
  try {
    const [trips] = await pool.execute(`
      SELECT t.*, r.name AS route_name, r.origin_name, r.destination_name,
        c.business_name AS company_name, f.name AS ferry_name,
        ou.name AS opened_by_name, cu.name AS closed_by_name, du.name AS deleted_by_name,
        ${tripIncomeExpression('o')} AS income_total,
        COUNT(o.id) AS operations_total,
        0 AS removed_total
      FROM trips t
      JOIN companies c ON c.id = t.company_id
      JOIN ferries f ON f.id = t.ferry_id
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN users cu ON cu.id = t.closed_by_user_id
      LEFT JOIN users du ON du.id = t.deleted_by_user_id
      LEFT JOIN operations o ON o.trip_id = t.id AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
      WHERE t.journey_id = ? AND t.deleted_at_utc IS NULL
      GROUP BY t.id
      ORDER BY t.id DESC
    `, [req.params.journeyId]);

    const [operations] = await pool.execute(`
      SELECT o.*, vt.name AS vehicle_type_name, vt.code AS vehicle_type_code,
        vc.name AS vehicle_category_name, vc.code AS vehicle_category_code, vc.plate_category,
        r.name AS route_name, f.name AS ferry_name,
        rb.name AS registered_by_name, bb.name AS billed_by_name, cu.name AS cashier_name,
        rem.name AS removed_by_name
      FROM operations o
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      JOIN trips t ON t.id = o.trip_id
      JOIN routes r ON r.id = t.route_id
      JOIN ferries f ON f.id = o.ferry_id
      JOIN users rb ON rb.id = o.registered_by_user_id
      JOIN users bb ON bb.id = o.billed_by_user_id
      JOIN users cu ON cu.id = o.cashier_user_id
      LEFT JOIN users rem ON rem.id = o.removed_from_trip_by_user_id
      WHERE o.journey_id = ? AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND t.deleted_at_utc IS NULL
      ORDER BY o.trip_id DESC, o.id DESC
    `, [req.params.journeyId]);

    const operationsByTrip = operations.reduce((acc, op) => {
      const key = String(op.trip_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(op);
      return acc;
    }, {});

    const totals = trips.reduce((acc, t) => {
      acc.trips += 1;
      acc.vehicles += Number(t.operations_total || 0);
      acc.income += Number(t.income_total || 0);
      return acc;
    }, { trips: 0, vehicles: 0, income: 0 });

    res.json({ success: true, data: { trips, operations_by_trip: operationsByTrip, totals } });
  } catch (error) { next(error); }
});

router.get('/journey/:journeyId', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT t.*, r.name AS route_name, ou.name AS opened_by_name, cu.name AS closed_by_name,
        ${tripIncomeExpression('o')} AS income_total,
        COUNT(o.id) AS operations_total
      FROM trips t
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN users cu ON cu.id = t.closed_by_user_id
      LEFT JOIN operations o ON o.trip_id = t.id AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
      WHERE t.journey_id = ? AND t.deleted_at_utc IS NULL
      GROUP BY t.id
      ORDER BY t.id DESC
    `, [req.params.journeyId]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/open', allowRoles('ADMIN','CASHIER','OPERATOR'), async (req, res, next) => {
  try {
    const { journey_id, route_id, notes } = req.body;
    if (!journey_id || !route_id) throw new AppError(400, 'VALIDATION_ERROR', 'Jornada y ruta son obligatorias.');

    let notification;
    const result = await withTransaction(async (conn) => {
      const [journeys] = await conn.execute('SELECT * FROM journeys WHERE id = ? AND status = \'OPEN\' FOR UPDATE', [journey_id]);
      const journey = journeys[0];
      if (!journey) throw new AppError(400, 'NO_OPEN_JOURNEY', 'La jornada no está abierta.');
      const [routeRows] = await conn.execute('SELECT * FROM routes WHERE id = ? AND active = 1 AND name IN (\'Magdalena -> Atlántico\', \'Atlántico -> Magdalena\')', [route_id]);
      const route = routeRows[0];
      if (!route) throw new AppError(400, 'INVALID_ROUTE', 'Solo se permiten los trayectos Magdalena -> Atlántico y Atlántico -> Magdalena.');

      const [open] = await conn.execute(`
        SELECT t.id, t.journey_id, t.route_id, r.name AS route_name
        FROM trips t
        JOIN routes r ON r.id = t.route_id
        WHERE t.ferry_id = ? AND t.status = 'OPEN' AND t.deleted_at_utc IS NULL
        FOR UPDATE
      `, [journey.ferry_id]);
      if (open.length) {
        throw new AppError(409, 'TRIP_ALREADY_OPEN', `Ya hay un trayecto abierto para este ferry: ${open[0].route_name}. Debes cerrarlo antes de abrir otro.`);
      }

      const [lastClosedRows] = await conn.execute(`
        SELECT t.id, t.route_id, r.name AS route_name, r.origin_name, r.destination_name, t.closed_at_utc
        FROM trips t
        JOIN routes r ON r.id = t.route_id
        WHERE t.ferry_id = ? AND t.journey_id = ? AND t.status = 'CLOSED' AND t.deleted_at_utc IS NULL
        ORDER BY COALESCE(t.closed_at_utc, t.opened_at_utc) DESC, t.id DESC
        LIMIT 1
      `, [journey.ferry_id, journey_id]);
      const lastClosed = lastClosedRows[0];
      if (lastClosed && Number(lastClosed.route_id) === Number(route_id)) {
        const [expectedRows] = await conn.execute(`
          SELECT id, name FROM routes
          WHERE active = 1 AND origin_name = ? AND destination_name = ?
          LIMIT 1
        `, [lastClosed.destination_name, lastClosed.origin_name]);
        const expectedRouteName = expectedRows[0]?.name || 'el trayecto contrario';
        throw new AppError(
          409,
          'TRIP_DIRECTION_SEQUENCE_INVALID',
          `No puedes abrir ${route.name} nuevamente dentro de esta misma jornada. El último trayecto cerrado de la jornada fue ${lastClosed.route_name}; en esta jornada debes abrir ${expectedRouteName}. En una jornada nueva esta validación inicia nuevamente.`,
          { last_closed_trip_id: lastClosed.id, last_route_id: lastClosed.route_id, requested_route_id: route_id, expected_route_id: expectedRows[0]?.id || null, journey_id }
        );
      }

      const [insert] = await conn.execute(`
        INSERT INTO trips (company_id, ferry_id, journey_id, route_id, opened_by_user_id, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [journey.company_id, journey.ferry_id, journey_id, route_id, req.user.id, notes || null]);
      const [rows] = await conn.execute(`
        SELECT t.*, r.name AS route_name, j.ferry_id, f.name AS ferry_name
        FROM trips t
        JOIN journeys j ON j.id = t.journey_id
        JOIN ferries f ON f.id = j.ferry_id
        JOIN routes r ON r.id = t.route_id
        WHERE t.id = ?`, [insert.insertId]);
      notification = await createNotification(conn, {
        type: 'trip:opened', severity: 'INFO', title: 'Trayecto abierto',
        message: `${req.user.name} abrió el trayecto ${rows[0].route_name}.`, payload: { trip_id: insert.insertId, opened_by_user_id: req.user.id }
      });
      return rows[0];
    });
    publishNotification(notification);
    emitToOperations('trip:opened', { id: result.id, status: result.status });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/close', allowRoles('ADMIN','CASHIER','OPERATOR'), setUploadFolder('trips'), upload.single('closure_photo'), async (req, res, next) => {
  try {
    if (req.user.role === 'OPERATOR' && !req.file) {
      throw new AppError(400, 'TRIP_CLOSURE_PHOTO_REQUIRED', 'El operador debe subir la foto general del trayecto para cerrar.');
    }
    const photoPath = filePathForDb(req.file, 'trips');
    let notification;
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM trips WHERE id = ? AND deleted_at_utc IS NULL FOR UPDATE', [req.params.id]);
      const trip = rows[0];
      if (!trip || trip.status !== 'OPEN') throw new AppError(404, 'TRIP_NOT_OPEN', 'El trayecto no existe o ya está cerrado.');
      await conn.execute(`
        UPDATE trips SET status = 'CLOSED', closed_by_user_id = ?, closed_at_utc = UTC_TIMESTAMP(), closure_photo_path = ?
        WHERE id = ?
      `, [req.user.id, photoPath, req.params.id]);
      notification = await createNotification(conn, {
        type: 'trip:closed', severity: 'INFO', title: 'Trayecto cerrado',
        message: `${req.user.name} cerró un trayecto${photoPath ? ' con soporte fotográfico' : ''}.`, payload: { trip_id: Number(req.params.id), closed_by_user_id: req.user.id, closure_photo_path: photoPath }
      });
      return { id: Number(req.params.id), status: 'CLOSED', closure_photo_path: photoPath };
    });
    publishNotification(notification);
    emitToOperations('trip:closed', { id: result.id, status: result.status });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/deactivate', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim() || 'Desactivado por administrador';
    let notification;
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM trips WHERE id = ? AND deleted_at_utc IS NULL FOR UPDATE', [req.params.id]);
      const trip = rows[0];
      if (!trip) throw new AppError(404, 'TRIP_NOT_FOUND', 'Trayecto no encontrado o ya desactivado.');
      await conn.execute(`
        UPDATE trips SET status = 'CANCELLED', deleted_at_utc = UTC_TIMESTAMP(), deleted_by_user_id = ?, delete_reason = ?
        WHERE id = ? AND deleted_at_utc IS NULL
      `, [req.user.id, reason, req.params.id]);

      await conn.execute(`
        UPDATE operations
        SET active_in_trip = 0,
            removed_from_trip_at_utc = COALESCE(removed_from_trip_at_utc, UTC_TIMESTAMP()),
            removed_from_trip_by_user_id = COALESCE(removed_from_trip_by_user_id, ?),
            removed_from_trip_reason = COALESCE(removed_from_trip_reason, ?)
        WHERE trip_id = ? AND active_in_trip = 1
      `, [req.user.id, `Trayecto desactivado: ${reason}`, req.params.id]);

      await conn.execute(`
        INSERT INTO operation_events (operation_id, event_type, user_id, details_json)
        SELECT id, 'TRIP_DEACTIVATED_OPERATION_IGNORED', ?, JSON_OBJECT('reason', ?)
        FROM operations
        WHERE trip_id = ?
      `, [req.user.id, reason, req.params.id]);

      notification = await createNotification(conn, {
        type: 'trip:deactivated', severity: 'WARNING', title: 'Trayecto desactivado',
        message: `${req.user.name} desactivó un trayecto. El trayecto y sus vehículos quedaron fuera de todos los conteos visibles.`,
        payload: { trip_id: Number(req.params.id), deleted_by_user_id: req.user.id, reason, operations_excluded: true }
      });
      return { id: Number(req.params.id), status: 'CANCELLED', operations_excluded: true };
    });
    publishNotification(notification);
    emitToOperations('trip:deactivated', { id: result.id, status: result.status });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
