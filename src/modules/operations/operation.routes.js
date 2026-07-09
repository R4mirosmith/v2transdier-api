import { Router } from 'express';
import path from 'path';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { upload, setUploadFolder } from '../../middlewares/upload.js';
import { AppError } from '../../utils/errors.js';
import { normalizePlate, validatePlate, validatePlateMatchesVehicleType } from '../../utils/plates.js';
import { createNotification, publishNotification } from '../notifications/notification.service.js';
import { emitToAdmins } from '../../sockets/index.js';

const router = Router();
router.use(authRequired);

function filePathForDb(file, folder) {
  if (!file) return null;
  return `/uploads/${folder}/${path.basename(file.path)}`;
}

async function notifyCritical(type, title, message, payload) {
  const notification = await createNotification(pool, { type, severity: 'DANGER', title, message, payload });
  publishNotification(notification);
}

function ticketNumberFor(id) {
  return `TK-${String(id).padStart(6, '0')}`;
}

const operationSelect = `
  SELECT o.*, vt.name AS vehicle_type_name, vt.code AS vehicle_type_code,
    rb.name AS registered_by_name, bb.name AS billed_by_name, u.name AS cashier_name, bu.name AS boarding_user_name,
    t.route_id, r.name AS route_name, f.name AS ferry_name, c.business_name AS company_name, c.trade_name, c.nit, c.logo_path, c.address, c.phone, c.electronic_billing_phone_1, c.electronic_billing_phone_2, c.email, c.ticket_footer
  FROM operations o
  JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
  JOIN users rb ON rb.id = o.registered_by_user_id
  JOIN users bb ON bb.id = o.billed_by_user_id
  JOIN users u ON u.id = o.cashier_user_id
  LEFT JOIN users bu ON bu.id = o.boarding_user_id
  JOIN trips t ON t.id = o.trip_id
  JOIN routes r ON r.id = t.route_id
  JOIN ferries f ON f.id = o.ferry_id
  JOIN companies c ON c.id = o.company_id
`;

router.get('/plate-lookup/:plate', allowRoles('CASHIER','OPERATOR','ADMIN'), async (req, res, next) => {
  try {
    const plateCheck = validatePlate(req.params.plate);
    if (!plateCheck.ok) {
      return res.json({ success: true, data: { exists: false, normalized_plate: plateCheck.normalized || normalizePlate(req.params.plate), valid_plate: false, message: plateCheck.message } });
    }

    const normalizedPlate = plateCheck.normalized;
    const [rows] = await pool.execute(`
      SELECT
        v.id AS vehicle_id,
        v.normalized_plate,
        v.display_plate,
        v.vehicle_type_id,
        v.active AS vehicle_active,
        vt.name AS vehicle_type_name,
        vt.code AS vehicle_type_code,
        vt.requires_load_status,
        vt.*,
        lo.driver_name,
        lo.driver_document,
        lo.driver_phone,
        lo.created_at_utc AS last_operation_at_utc
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      LEFT JOIN operations lo ON lo.id = (
        SELECT o2.id
        FROM operations o2
        JOIN trips tr2 ON tr2.id = o2.trip_id
        WHERE o2.vehicle_id = v.id
          AND o2.active_in_trip = 1
          AND o2.status NOT IN ('ANNULLED','REMOVED')
          AND tr2.deleted_at_utc IS NULL
        ORDER BY o2.created_at_utc DESC, o2.id DESC
        LIMIT 1
      )
      WHERE v.normalized_plate = ?
      LIMIT 1
    `, [normalizedPlate]);

    const vehicle = rows[0];
    if (!vehicle) {
      return res.json({ success: true, data: { exists: false, normalized_plate: normalizedPlate, valid_plate: true } });
    }

    res.json({
      success: true,
      data: {
        exists: true,
        lock_type: true,
        vehicle_id: vehicle.vehicle_id,
        normalized_plate: vehicle.normalized_plate,
        display_plate: vehicle.display_plate,
        vehicle_type_id: vehicle.vehicle_type_id,
        vehicle_type_name: vehicle.vehicle_type_name,
        vehicle_type_code: vehicle.vehicle_type_code,
        requires_load_status: !!vehicle.requires_load_status,
        registration_restricted: !!vehicle.registration_restricted,
        vehicle_active: !!vehicle.vehicle_active,
        driver_name: vehicle.driver_name || '',
        driver_document: vehicle.driver_document || '',
        driver_phone: vehicle.driver_phone || '',
        last_operation_at_utc: vehicle.last_operation_at_utc || null
      }
    });
  } catch (error) { next(error); }
});

router.get('/trip/:tripId', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      ${operationSelect}
      WHERE o.trip_id = ?
        AND o.active_in_trip = 1
        AND o.status NOT IN ('ANNULLED','REMOVED')
        AND t.deleted_at_utc IS NULL
      ORDER BY o.id DESC
    `, [req.params.tripId]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`${operationSelect} WHERE o.id = ?`, [req.params.id]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Operación no encontrada.');
    res.json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
});

router.get('/:id/ticket', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`${operationSelect} WHERE o.id = ?`, [req.params.id]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Ticket no encontrado.');
    res.json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
});

router.post('/register', allowRoles('CASHIER','OPERATOR','ADMIN'), setUploadFolder('payments'), upload.single('payment_photo'), async (req, res, next) => {
  let pendingNotification = null;
  try {
    const plateCheck = validatePlate(req.body.plate);
    if (!plateCheck.ok) throw new AppError(400, 'INVALID_PLATE', plateCheck.message);

    const tripId = Number(req.body.trip_id);
    const vehicleTypeId = Number(req.body.vehicle_type_id);
    const driverName = String(req.body.driver_name || '').trim();
    const driverDocument = String(req.body.driver_document || '').trim();
    const driverPhone = String(req.body.driver_phone || '').trim();
    const loadStatusInput = String(req.body.load_status || 'NA').toUpperCase();

    if (!tripId || !vehicleTypeId) throw new AppError(400, 'VALIDATION_ERROR', 'Trayecto y tipo de vehículo son obligatorios.');
    if (!driverName || !driverDocument || !driverPhone) throw new AppError(400, 'DRIVER_REQUIRED', 'Nombre, documento y teléfono del conductor son obligatorios.');

    const normalizedPlate = plateCheck.normalized;
    const displayPlate = String(req.body.plate || '').trim().toUpperCase();
    const paymentPhotoPath = filePathForDb(req.file, 'payments');

    const result = await withTransaction(async (conn) => {
      const [tripRows] = await conn.execute(`
        SELECT t.*, j.status AS journey_status
        FROM trips t JOIN journeys j ON j.id = t.journey_id
        WHERE t.id = ? AND t.deleted_at_utc IS NULL FOR UPDATE
      `, [tripId]);
      const trip = tripRows[0];
      const isAdminClosedTripCorrection = req.user.role === 'ADMIN' && trip?.status === 'CLOSED';
      const isNormalOpenTrip = trip?.status === 'OPEN' && trip?.journey_status === 'OPEN';
      if (!trip || (!isNormalOpenTrip && !isAdminClosedTripCorrection)) {
        throw new AppError(400, 'TRIP_NOT_WORKABLE', 'El trayecto no está disponible para facturar. Solo el admin puede agregar vehículos a un trayecto cerrado.');
      }

      const [typeRows] = await conn.execute('SELECT * FROM vehicle_types WHERE id = ? AND active = 1', [vehicleTypeId]);
      const vehicleType = typeRows[0];
      if (!vehicleType) throw new AppError(400, 'INVALID_VEHICLE_TYPE', 'Tipo de vehículo inválido.');

      const plateTypeCheck = validatePlateMatchesVehicleType(normalizedPlate, vehicleType);
      if (!plateTypeCheck.ok) {
        throw new AppError(400, 'PLATE_TYPE_MISMATCH', plateTypeCheck.message, {
          plate: normalizedPlate,
          vehicle_type_id: vehicleTypeId,
          vehicle_type_name: vehicleType.name,
          detected_category: plateTypeCheck.category,
          expected_category: plateTypeCheck.expectedCategory,
          user_id: req.user.id
        });
      }

      const loadStatus = vehicleType.requires_load_status ? loadStatusInput : 'NA';
      if (!['LOADED','EMPTY','NA'].includes(loadStatus)) throw new AppError(400, 'INVALID_LOAD_STATUS', 'Condición de carga inválida.');

      const cashSession = null;

      const [existingOps] = await conn.execute("SELECT id FROM operations WHERE trip_id = ? AND normalized_plate = ? AND active_in_trip = 1 AND status NOT IN ('ANNULLED','REMOVED') LIMIT 1", [tripId, normalizedPlate]);
      if (existingOps.length) {
        throw new AppError(409, 'DUPLICATE_VEHICLE_IN_TRIP', 'Este vehículo ya fue registrado en este trayecto.', {
          trip_id: tripId,
          plate: normalizedPlate,
          user_id: req.user.id
        });
      }

      let vehicleId;
      const [vehicleRows] = await conn.execute('SELECT * FROM vehicles WHERE normalized_plate = ? FOR UPDATE', [normalizedPlate]);
      const existingVehicle = vehicleRows[0];
      if (existingVehicle && Number(existingVehicle.vehicle_type_id) !== vehicleTypeId) {
        const [oldTypeRows] = await conn.execute('SELECT name FROM vehicle_types WHERE id = ?', [existingVehicle.vehicle_type_id]);
        const oldTypeName = oldTypeRows[0]?.name || 'otro tipo';
        throw new AppError(409, 'VEHICLE_TYPE_CONFLICT', `La placa ${normalizedPlate} ya está registrada como ${oldTypeName}. No puede registrarse como ${vehicleType.name}.`, {
          plate: normalizedPlate,
          old_vehicle_type_id: existingVehicle.vehicle_type_id,
          old_vehicle_type_name: oldTypeName,
          attempted_vehicle_type_id: vehicleTypeId,
          attempted_vehicle_type_name: vehicleType.name,
          user_id: req.user.id
        });
      }

      if (!existingVehicle && Number(vehicleType.registration_restricted) === 1) {
        throw new AppError(403, 'VEHICLE_TYPE_RESTRICTED_FOR_NEW', `El tipo ${vehicleType.name} está restringido para vehículos nuevos. Pide al administrador que quite la restricción temporalmente para poder registrar esta placa.`, {
          plate: normalizedPlate,
          vehicle_type_id: vehicleTypeId,
          vehicle_type_name: vehicleType.name,
          user_id: req.user.id
        });
      }

      if (existingVehicle) {
        vehicleId = existingVehicle.id;
      } else {
        const [insertVehicle] = await conn.execute('INSERT INTO vehicles (normalized_plate, display_plate, vehicle_type_id) VALUES (?, ?, ?)', [normalizedPlate, displayPlate, vehicleTypeId]);
        vehicleId = insertVehicle.insertId;
      }

      const [driverRows] = await conn.execute('SELECT * FROM drivers WHERE document = ? FOR UPDATE', [driverDocument]);
      let driverId;
      if (driverRows[0]) {
        driverId = driverRows[0].id;
        await conn.execute('UPDATE drivers SET name = ?, phone = ?, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [driverName, driverPhone, driverId]);
      } else {
        const [insertDriver] = await conn.execute('INSERT INTO drivers (document, name, phone) VALUES (?, ?, ?)', [driverDocument, driverName, driverPhone]);
        driverId = insertDriver.insertId;
      }

      const [exemptRows] = await conn.execute('SELECT * FROM exempt_plates WHERE normalized_plate = ? AND active = 1 LIMIT 1', [normalizedPlate]);
      const isExempt = !!exemptRows[0];

      let price = 0;
      let paymentMethod = 'EXEMPT';
      let status = 'EXEMPT';
      if (!isExempt) {
        const [fareRows] = await conn.execute(`
          SELECT price FROM vehicle_fares
          WHERE vehicle_type_id = ? AND load_status = ? AND active = 1
          LIMIT 1
        `, [vehicleTypeId, loadStatus]);
        if (!fareRows.length) throw new AppError(400, 'NO_ACTIVE_FARE', 'No hay tarifa activa para este tipo y condición.');
        price = Number(fareRows[0].price);
        paymentMethod = 'CASH';
        status = 'PAID';
      }

      const [insertOp] = await conn.execute(`
        INSERT INTO operations (
          company_id, journey_id, trip_id, ferry_id, vehicle_id, normalized_plate, display_plate, vehicle_type_id, load_status,
          driver_id, driver_name, driver_document, driver_phone, fare_price, payment_method, status,
          registered_by_user_id, billed_by_user_id, cashier_user_id, cash_session_id, optional_payment_photo_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [trip.company_id, trip.journey_id, tripId, trip.ferry_id, vehicleId, normalizedPlate, displayPlate, vehicleTypeId, loadStatus, driverId, driverName, driverDocument, driverPhone, price, paymentMethod, status, req.user.id, req.user.id, req.user.id, cashSession?.id || null, paymentPhotoPath]);

      const opId = insertOp.insertId;
      const ticketNumber = ticketNumberFor(opId);
      await conn.execute('UPDATE operations SET ticket_number = ?, invoice_number = ? WHERE id = ?', [ticketNumber, ticketNumber, opId]);
      await conn.execute('INSERT INTO operation_events (operation_id, event_type, user_id, details_json) VALUES (?, ?, ?, ?)', [opId, 'REGISTERED_AND_TICKETED', req.user.id, JSON.stringify({ price, loadStatus, paymentMethod, ticketNumber, admin_closed_trip_correction: isAdminClosedTripCorrection })]);

      const [opRows] = await conn.execute(`${operationSelect} WHERE o.id = ?`, [opId]);
      const operation = opRows[0];

      pendingNotification = await createNotification(conn, {
        type: 'vehicle:registered',
        severity: isExempt ? 'WARNING' : 'SUCCESS',
        title: isAdminClosedTripCorrection ? 'Vehículo agregado a trayecto cerrado' : (isExempt ? 'Exonerado registrado' : 'Vehículo cobrado'),
        message: `${req.user.name} facturó ${normalizedPlate} (${vehicleType.name}) por $${price.toLocaleString('es-CO')}${isAdminClosedTripCorrection ? ' como corrección administrativa de trayecto cerrado' : ''}.`,
        payload: { operation_id: opId, trip_id: tripId, plate: normalizedPlate, price, status, ticket_number: ticketNumber, registered_by_user_id: req.user.id, billed_by_user_id: req.user.id, admin_closed_trip_correction: isAdminClosedTripCorrection }
      });
      return operation;
    });

    publishNotification(pendingNotification);
    emitToAdmins('operation:registered', result);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      await notifyCritical('vehicle:duplicate_attempt', 'Duplicado bloqueado', 'La base de datos bloqueó un duplicado por concurrencia.', { plate: normalizePlate(req.body.plate), trip_id: req.body.trip_id });
      return next(new AppError(409, 'DUPLICATE_VEHICLE_IN_TRIP', 'Este vehículo ya fue registrado en este trayecto.'));
    }
    if (error?.code === 'DUPLICATE_VEHICLE_IN_TRIP') {
      await notifyCritical('vehicle:duplicate_attempt', 'Duplicado bloqueado', `Intentaron registrar nuevamente la placa ${normalizePlate(req.body.plate)} en el mismo trayecto.`, error.details || { plate: normalizePlate(req.body.plate), trip_id: req.body.trip_id });
    }
    if (error?.code === 'VEHICLE_TYPE_CONFLICT') {
      await notifyCritical('vehicle:type_conflict', 'Tipo de vehículo inválido', error.message, error.details || { plate: normalizePlate(req.body.plate), trip_id: req.body.trip_id });
    }
    if (error?.code === 'PLATE_TYPE_MISMATCH') {
      await notifyCritical('vehicle:plate_type_mismatch', 'Placa no coincide con el tipo', error.message, error.details || { plate: normalizePlate(req.body.plate), trip_id: req.body.trip_id });
    }
    next(error);
  }
});

router.post('/:id/board', allowRoles('OPERATOR','CASHIER','ADMIN'), setUploadFolder('boarding'), upload.single('boarding_photo'), async (req, res, next) => {
  let notification;
  try {
    const photoPath = filePathForDb(req.file, 'boarding');
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM operations WHERE id = ? FOR UPDATE', [req.params.id]);
      const op = rows[0];
      if (!op) throw new AppError(404, 'NOT_FOUND', 'Operación no encontrada.');
      if (!['PAID','EXEMPT'].includes(op.status)) throw new AppError(409, 'INVALID_STATUS', 'Solo puedes embarcar vehículos pagados o exonerados.');
      if (req.user.role === 'OPERATOR' && Number(op.fare_price) === 0 && !photoPath) {
        throw new AppError(400, 'BOARDING_PHOTO_REQUIRED', 'La foto individual es obligatoria para tarifa 0 cuando embarca el operador.');
      }
      await conn.execute(`
        UPDATE operations
        SET status = 'BOARDED', boarding_photo_path = ?, boarding_user_id = ?, boarded_at_utc = UTC_TIMESTAMP()
        WHERE id = ?
      `, [photoPath, req.user.id, op.id]);
      await conn.execute('INSERT INTO operation_events (operation_id, event_type, user_id, details_json) VALUES (?, ?, ?, ?)', [op.id, photoPath ? 'BOARDED_WITH_PHOTO' : 'BOARDED_NO_PHOTO', req.user.id, JSON.stringify({ photoPath })]);
      const [updated] = await conn.execute(`${operationSelect} WHERE o.id = ?`, [op.id]);
      notification = await createNotification(conn, {
        type: 'vehicle:boarded', severity: 'INFO', title: 'Vehículo embarcado',
        message: `${req.user.name} confirmó embarque de ${op.normalized_plate}${photoPath ? ' con foto' : ''}.`,
        payload: { operation_id: op.id, plate: op.normalized_plate, boarding_user_id: req.user.id }
      });
      return updated[0];
    });
    publishNotification(notification);
    emitToAdmins('operation:boarded', result);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/remove-from-trip', allowRoles('ADMIN'), async (req, res, next) => {
  let notification;
  try {
    const reason = String(req.body.reason || '').trim() || 'Retirado del trayecto por administrador';
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM operations WHERE id = ? FOR UPDATE', [req.params.id]);
      const op = rows[0];
      if (!op) throw new AppError(404, 'NOT_FOUND', 'Operación no encontrada.');
      await conn.execute(`
        UPDATE operations SET active_in_trip = 0, removed_from_trip_at_utc = UTC_TIMESTAMP(), removed_from_trip_by_user_id = ?, removed_from_trip_reason = ?
        WHERE id = ?
      `, [req.user.id, reason, op.id]);
      await conn.execute('INSERT INTO operation_events (operation_id, event_type, user_id, details_json) VALUES (?, ?, ?, ?)', [op.id, 'REMOVED_FROM_TRIP', req.user.id, JSON.stringify({ reason })]);
      notification = await createNotification(conn, {
        type: 'vehicle:removed_from_trip', severity: 'WARNING', title: 'Vehículo retirado del trayecto',
        message: `${req.user.name} retiró ${op.normalized_plate} del trayecto sin borrar el ticket histórico.`,
        payload: { operation_id: op.id, reason }
      });
      return { id: op.id, active_in_trip: 0 };
    });
    publishNotification(notification);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/cancel', allowRoles('ADMIN'), async (req, res, next) => {
  let notification;
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError(400, 'REASON_REQUIRED', 'El motivo de anulación es obligatorio.');
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM operations WHERE id = ? FOR UPDATE', [req.params.id]);
      const op = rows[0];
      if (!op) throw new AppError(404, 'NOT_FOUND', 'Operación no encontrada.');
      if (op.status === 'ANNULLED') throw new AppError(409, 'ALREADY_CANCELLED', 'La operación ya está anulada.');
      await conn.execute(`
        UPDATE operations
        SET status = 'ANNULLED', cancellation_reason = ?, cancelled_by_user_id = ?, cancelled_at_utc = UTC_TIMESTAMP()
        WHERE id = ?
      `, [reason, req.user.id, op.id]);
      await conn.execute('INSERT INTO operation_events (operation_id, event_type, user_id, details_json) VALUES (?, ?, ?, ?)', [op.id, 'CANCELLED', req.user.id, JSON.stringify({ reason })]);
      notification = await createNotification(conn, {
        type: 'ticket:cancelled', severity: 'DANGER', title: 'Ticket anulado',
        message: `${req.user.name} anuló ${op.ticket_number || op.invoice_number} - ${op.normalized_plate}. Motivo: ${reason}`,
        payload: { operation_id: op.id, ticket_number: op.ticket_number || op.invoice_number, reason }
      });
      return { id: op.id, status: 'ANNULLED' };
    });
    publishNotification(notification);
    emitToAdmins('operation:cancelled', result);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
