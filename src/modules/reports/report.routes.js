import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { fromColombiaDateRangeToUtc, todayColombiaRangeToUtc } from '../../utils/time.js';
import { sendHtmlTableExport } from '../../utils/exporters.js';
import { centsToMoney, moneyToCents } from '../../utils/money.js';

const router = Router();
router.use(authRequired);
function estadoOperacionTexto(status) {
  return ({
    PAID: 'Pagado',
    EXEMPT: 'Tarifa 0',
    BOARDED: 'Embarcado',
    ANNULLED: 'Anulado',
    REMOVED: 'Retirado'
  })[status] || status || '';
}

function condicionTexto(status) {
  return ({ LOADED: 'Cargado', EMPTY: 'Descargado', NA: 'No aplica' })[status] || status || '';
}

function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isInteger(v) && v > 0);
}

function inClause(ids) {
  return ids.length ? `(${ids.map(() => '?').join(',')})` : '';
}


function operationWhereFromQuery(query, forceToday = false) {
  const params = [];
  let where = "o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND t.deleted_at_utc IS NULL";
  if (query.company_id) { where += ' AND o.company_id = ?'; params.push(query.company_id); }
  if (query.ferry_id) { where += ' AND o.ferry_id = ?'; params.push(query.ferry_id); }
  const journeyIds = parseIdList(query.journey_ids);
  if (journeyIds.length) { where += ` AND o.journey_id IN ${inClause(journeyIds)}`; params.push(...journeyIds); }
  else if (query.journey_id) { where += ' AND o.journey_id = ?'; params.push(query.journey_id); }
  if (query.trip_id) { where += ' AND o.trip_id = ?'; params.push(query.trip_id); }
  if (query.vehicle_type_id) { where += ' AND o.vehicle_type_id = ?'; params.push(query.vehicle_type_id); }
  if (query.vehicle_category_id) { where += ' AND o.vehicle_category_id = ?'; params.push(query.vehicle_category_id); }

  if (query.journey_from) {
    const { startUtc, endUtc } = fromColombiaDateRangeToUtc(query.journey_from, query.journey_to || query.journey_from);
    where += ' AND j.opened_at_utc BETWEEN ? AND ?'; params.push(startUtc, endUtc);
  } else if (forceToday) {
    const { startUtc, endUtc } = todayColombiaRangeToUtc();
    where += ' AND o.created_at_utc BETWEEN ? AND ?'; params.push(startUtc, endUtc);
  } else if (query.from) {
    const { startUtc, endUtc } = fromColombiaDateRangeToUtc(query.from, query.to || query.from);
    where += ' AND o.created_at_utc BETWEEN ? AND ?'; params.push(startUtc, endUtc);
  }
  return { where, params };
}

const operationsSelect = `
  SELECT o.*, vt.name AS vehicle_type_name,
         vc.name AS vehicle_category_name, vc.code AS vehicle_category_code, vc.plate_category,
         u.name AS cashier_name,
         rb.name AS registered_by_name, rb.role AS registered_by_role,
         bb.name AS billed_by_name, bb.role AS billed_by_role,
         bu.name AS boarding_by_name,
         f.name AS ferry_name, c.business_name AS company_name, r.name AS route_name,
         DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
         j.status AS journey_status,
         t.status AS trip_status,
         t.opened_at_utc AS trip_opened_at_utc,
         t.closed_at_utc AS trip_closed_at_utc,
         t.opened_by_user_id, tu.name AS trip_opened_by_name,
         t.closed_by_user_id, tcu.name AS trip_closed_by_name
  FROM operations o
  JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
  JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
  JOIN users u ON u.id = o.cashier_user_id
  JOIN users rb ON rb.id = o.registered_by_user_id
  JOIN users bb ON bb.id = o.billed_by_user_id
  LEFT JOIN users bu ON bu.id = o.boarding_user_id
  JOIN ferries f ON f.id = o.ferry_id
  JOIN companies c ON c.id = o.company_id
  JOIN journeys j ON j.id = o.journey_id
  JOIN trips t ON t.id = o.trip_id
  JOIN routes r ON r.id = t.route_id
  LEFT JOIN users tu ON tu.id = t.opened_by_user_id
  LEFT JOIN users tcu ON tcu.id = t.closed_by_user_id
`;

router.get('/dashboard', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const report = await buildFinancialReport(req.query);
    const [openJourneys] = await pool.execute("SELECT COUNT(*) AS total FROM journeys WHERE status = 'OPEN'");
    const [openTrips] = await pool.execute("SELECT COUNT(*) AS total FROM trips WHERE status = 'OPEN' AND deleted_at_utc IS NULL");

    const tripTypeTotals = [];
    for (const trip of report.by_trip) {
      for (const type of trip.types || []) {
        tripTypeTotals.push({
          journey_id: trip.journey_id,
          journey_local_date: trip.journey_local_date,
          trip_id: trip.trip_id,
          route_id: trip.route_id,
          route_name: trip.route_name,
          ferry_id: trip.ferry_id,
          ferry_name: trip.ferry_name,
          vehicle_type_id: type.vehicle_type_id,
          vehicle_type_name: type.vehicle_type_name,
          vehicle_category_id: type.vehicle_category_id,
          vehicle_category_name: type.vehicle_category_name,
          vehicle_category_code: type.vehicle_category_code,
          load_status: type.load_status,
          qty: type.qty,
          total: type.total
        });
      }
    }

    const boarded = report.operations.filter(o => o.status === 'BOARDED').length;
    const pendingBoard = report.operations.filter(o => ['PAID', 'EXEMPT'].includes(o.status)).length;

    res.json({
      success: true,
      data: {
        filter_mode: report.filter.from === report.filter.to ? 'date' : 'range',
        filter_from: report.filter.from,
        filter_to: report.filter.to,
        selected_journey_ids: [],
        journey_options: report.journeys,
        open_journeys: Number(openJourneys[0]?.total || 0),
        open_trips: Number(openTrips[0]?.total || 0),
        journeys_total: report.summary.journeys_total,
        trips_total: report.summary.trips_total,
        operations: report.summary.vehicles_total,
        total_cash: report.summary.income_total,
        total_expenses: report.summary.expenses_total,
        net_today: report.summary.net_total,
        boarded,
        pending_board: pendingBoard,
        exempt: report.summary.exempt_total,
        by_ferry: report.by_ferry.map(row => ({
          id: row.ferry_id,
          ferry_name: row.ferry_name,
          operations: row.vehicles_total,
          income: row.income_total,
          expenses: row.expenses_total,
          net: row.net_total,
          trips_total: row.trips_total,
          journeys_total: row.journeys_total
        })),
        journey_ferry_totals: report.by_journey.map(row => ({
          journey_id: row.journey_id,
          local_date: row.journey_local_date,
          journey_status: row.journey_status,
          ferry_id: row.ferry_id,
          ferry_name: row.ferry_name,
          vehicles_total: row.vehicles_total,
          income_total: row.income_total,
          expenses_total: row.expenses_total,
          net_total: row.net_total,
          exempt_total: row.exempt_total,
          trips_total: row.trips_total
        })),
        journey_ferry_type_totals: [],
        trip_type_totals: tripTypeTotals,
        category_totals: report.by_vehicle_category.map(row => ({
          vehicle_category_id: row.vehicle_category_id,
          vehicle_category_code: row.vehicle_category_code,
          vehicle_category_name: row.vehicle_category_name,
          qty: row.qty,
          total: row.total
        })),
        type_totals: report.by_vehicle_type,
        operations_detail: report.operations,
        billed_by_totals: report.by_user,
        integrity: report.integrity
      }
    });
  } catch (error) { next(error); }
});

router.get('/journey/:journeyId/summary', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const [summary] = await pool.execute(`
      SELECT
        COUNT(o.id) AS total_operations,
        SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END) AS total_cash,
        SUM(CASE WHEN o.status = 'BOARDED' THEN 1 ELSE 0 END) AS boarded,
        SUM(CASE WHEN o.status IN ('PAID','EXEMPT') THEN 1 ELSE 0 END) AS pending_board,
        0 AS cancelled,
        SUM(CASE WHEN o.payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      WHERE o.journey_id = ? AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND t.deleted_at_utc IS NULL
    `, [req.params.journeyId]);
    const [byType] = await pool.execute(`
      SELECT o.vehicle_type_id, vt.name,
        o.vehicle_category_id, vc.name AS vehicle_category_name, vc.code AS vehicle_category_code,
        o.load_status, COUNT(*) AS qty, SUM(o.fare_price) AS total
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      WHERE o.journey_id = ? AND o.status NOT IN ('ANNULLED','REMOVED') AND o.active_in_trip = 1 AND t.deleted_at_utc IS NULL
      GROUP BY o.vehicle_type_id, vt.name, o.vehicle_category_id, vc.name, vc.code, o.load_status
      ORDER BY vt.name, o.load_status
    `, [req.params.journeyId]);
    const [trips] = await pool.execute(`
      SELECT t.*, r.name AS route_name,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method='CASH' THEN o.fare_price ELSE 0 END),0) AS total_cash,
        COUNT(o.id) AS total_operations
      FROM trips t
      JOIN routes r ON r.id = t.route_id
      LEFT JOIN operations o ON o.trip_id = t.id AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED')
      WHERE t.journey_id = ? AND t.deleted_at_utc IS NULL
      GROUP BY t.id
      ORDER BY t.id DESC
    `, [req.params.journeyId]);
    const [expenses] = await pool.execute(`
      SELECT category, COUNT(*) AS qty, SUM(amount) AS total FROM expenses WHERE journey_id = ? AND status = 'ACTIVE' GROUP BY category ORDER BY category
    `, [req.params.journeyId]);
    const [cash] = await pool.execute(`
      SELECT cs.*, u.name AS cashier_name
      FROM cash_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE cs.journey_id = ? ORDER BY cs.id DESC
    `, [req.params.journeyId]);
    res.json({ success: true, data: { summary: summary[0], by_type: byType, trips, expenses, cash_sessions: cash } });
  } catch (error) { next(error); }
});

router.get('/journey/:journeyId/type/:vehicleTypeId/detail', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      ${operationsSelect}
      WHERE o.journey_id = ? AND o.vehicle_type_id = ? AND o.status NOT IN ('ANNULLED','REMOVED') AND o.active_in_trip = 1 AND t.deleted_at_utc IS NULL
      ORDER BY o.id DESC
    `, [req.params.journeyId, req.params.vehicleTypeId]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/trip/:tripId/summary', async (req, res, next) => {
  try {
    const [summary] = await pool.execute(`
      SELECT COUNT(*) AS total_operations,
             COALESCE(SUM(CASE WHEN status IN ('PAID','BOARDED') AND payment_method='CASH' THEN fare_price ELSE 0 END), 0) AS income_total,
             SUM(CASE WHEN payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt_total
      FROM operations o WHERE o.trip_id = ? AND o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND EXISTS (SELECT 1 FROM trips tx WHERE tx.id = o.trip_id AND tx.deleted_at_utc IS NULL)
    `, [req.params.tripId]);
    const [byType] = await pool.execute(`
      SELECT
        o.vehicle_type_id,
        vt.name AS vehicle_type_name,
        o.vehicle_category_id,
        vc.name AS vehicle_category_name,
        vc.code AS vehicle_category_code,
        COUNT(*) AS qty,
        COALESCE(SUM(o.fare_price), 0) AS total
      FROM operations o
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      WHERE o.trip_id = ?
        AND o.active_in_trip = 1
        AND o.status NOT IN ('ANNULLED','REMOVED')
        AND EXISTS (SELECT 1 FROM trips tx WHERE tx.id = o.trip_id AND tx.deleted_at_utc IS NULL)
      GROUP BY o.vehicle_type_id, vt.name, o.vehicle_category_id, vc.name, vc.code
      ORDER BY vc.name, vt.name
    `, [req.params.tripId]);
    res.json({ success: true, data: { summary: summary[0], by_type: byType } });
  } catch (error) { next(error); }
});


router.get('/travel-history', allowRoles('ADMIN', 'CASHIER', 'OPERATOR'), async (req, res, next) => {
  try {
    const canSeeAll = req.user.role === 'ADMIN';
    const today = todayColombiaRangeToUtc();
    const from = req.query.from || today.localDate;
    const requestedTo = req.query.to || from;
    const to = requestedTo < from ? from : requestedTo;
    const { startUtc, endUtc } = fromColombiaDateRangeToUtc(from, to);
    const ferryId = canSeeAll && req.query.ferry_id ? Number(req.query.ferry_id) : null;
    const ownUserId = canSeeAll ? null : Number(req.user.id);

    const tripParams = [startUtc, endUtc];
    let tripWhere = 'j.opened_at_utc BETWEEN ? AND ? AND t.deleted_at_utc IS NULL';
    if (ferryId) { tripWhere += ' AND t.ferry_id = ?'; tripParams.push(ferryId); }
    if (ownUserId) {
      tripWhere += ` AND (
        t.opened_by_user_id = ?
        OR t.closed_by_user_id = ?
        OR EXISTS (
          SELECT 1
          FROM operations ox
          WHERE ox.trip_id = t.id
            AND ox.active_in_trip = 1
            AND ox.status NOT IN ('ANNULLED','REMOVED')
            AND (ox.registered_by_user_id = ? OR ox.billed_by_user_id = ? OR ox.boarding_user_id = ?)
        )
      )`;
      tripParams.push(ownUserId, ownUserId, ownUserId, ownUserId, ownUserId);
    }

    const [tripRows] = await pool.execute(`
      SELECT
        t.id,
        t.status,
        t.opened_at_utc,
        t.closed_at_utc,
        t.journey_id,
        t.opened_by_user_id,
        t.closed_by_user_id,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
        f.id AS ferry_id,
        f.name AS ferry_name,
        r.name AS route_name,
        r.origin_name,
        r.destination_name,
        ou.name AS opened_by_name,
        cu.name AS closed_by_name
      FROM trips t
      JOIN journeys j ON j.id = t.journey_id
      JOIN ferries f ON f.id = t.ferry_id
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN users cu ON cu.id = t.closed_by_user_id
      WHERE ${tripWhere}
      ORDER BY j.opened_at_utc DESC, t.id DESC
    `, tripParams);

    const opParams = [startUtc, endUtc];
    let opWhere = `
      o.active_in_trip = 1
      AND o.status NOT IN ('ANNULLED','REMOVED')
      AND t.deleted_at_utc IS NULL
      AND j.opened_at_utc BETWEEN ? AND ?
    `;
    if (ferryId) { opWhere += ' AND o.ferry_id = ?'; opParams.push(ferryId); }
    if (ownUserId) {
      opWhere += ' AND (o.registered_by_user_id = ? OR o.billed_by_user_id = ? OR o.boarding_user_id = ?)';
      opParams.push(ownUserId, ownUserId, ownUserId);
    }

    const [operations] = await pool.execute(`
      ${operationsSelect}
      WHERE ${opWhere}
      ORDER BY j.opened_at_utc DESC, o.trip_id DESC, o.id DESC
    `, opParams);

    const operationsByTrip = operations.reduce((acc, op) => {
      const key = String(op.trip_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(op);
      return acc;
    }, {});

    const trips = tripRows.map(trip => {
      const tripOps = operationsByTrip[String(trip.id)] || [];
      let incomeCents = 0;
      let registeredTotal = 0;
      let billedTotal = 0;
      let boardedTotal = 0;
      let exemptTotal = 0;

      for (const op of tripOps) {
        const isCashIncome = ['PAID', 'BOARDED'].includes(op.status) && op.payment_method === 'CASH';
        const countsAsOwnIncome = canSeeAll || Number(op.billed_by_user_id) === ownUserId;
        if (isCashIncome && countsAsOwnIncome) incomeCents += moneyToCents(op.fare_price);
        if (ownUserId && Number(op.registered_by_user_id) === ownUserId) registeredTotal += 1;
        if (ownUserId && Number(op.billed_by_user_id) === ownUserId) billedTotal += 1;
        if (ownUserId && Number(op.boarding_user_id) === ownUserId) boardedTotal += 1;
        if (op.payment_method === 'EXEMPT') exemptTotal += 1;
      }

      return {
        ...trip,
        operations_total: tripOps.length,
        income_total: centsToMoney(incomeCents),
        exempt_total: exemptTotal,
        registered_total: ownUserId ? registeredTotal : null,
        billed_total: ownUserId ? billedTotal : null,
        boarded_total: ownUserId ? boardedTotal : null,
        opened_by_me: ownUserId ? Number(trip.opened_by_user_id) === ownUserId : false,
        closed_by_me: ownUserId ? Number(trip.closed_by_user_id) === ownUserId : false
      };
    });

    const journeyIds = new Set(trips.map(t => String(t.journey_id)));
    const summaryIncomeCents = trips.reduce((sum, trip) => sum + moneyToCents(trip.income_total), 0);
    const summary = {
      journeys_total: journeyIds.size,
      trips_total: trips.length,
      vehicles_total: operations.length,
      income_total: centsToMoney(summaryIncomeCents),
      exempt_total: operations.filter(op => op.payment_method === 'EXEMPT').length,
      registered_total: ownUserId ? operations.filter(op => Number(op.registered_by_user_id) === ownUserId).length : null,
      billed_total: ownUserId ? operations.filter(op => Number(op.billed_by_user_id) === ownUserId).length : null,
      boarded_total: ownUserId ? operations.filter(op => Number(op.boarding_user_id) === ownUserId).length : null
    };

    const byJourney = Array.from(trips.reduce((map, trip) => {
      const key = `${trip.journey_id}-${trip.ferry_id}`;
      if (!map.has(key)) map.set(key, {
        journey_id: trip.journey_id,
        journey_local_date: trip.journey_local_date,
        ferry_id: trip.ferry_id,
        ferry_name: trip.ferry_name,
        trips_total: 0,
        vehicles_total: 0,
        _income_cents: 0,
        exempt_total: 0
      });
      const row = map.get(key);
      row.trips_total += 1;
      row.vehicles_total += Number(trip.operations_total || 0);
      row._income_cents += moneyToCents(trip.income_total);
      row.exempt_total += Number(trip.exempt_total || 0);
      return map;
    }, new Map()).values()).map(row => {
      const result = { ...row, income_total: centsToMoney(row._income_cents) };
      delete result._income_cents;
      return result;
    });

    res.json({
      success: true,
      data: {
        filter: { from, to, ferry_id: ferryId, forced_today: false, own_user_only: !!ownUserId },
        summary,
        by_journey: byJourney,
        trips,
        operations_by_trip: operationsByTrip
      }
    });
  } catch (error) { next(error); }
});

router.get('/today', async (req, res, next) => {
  try {
    const { localDate } = todayColombiaRangeToUtc();
    const { where, params } = operationWhereFromQuery({}, true);
    const [rows] = await pool.execute(`${operationsSelect} WHERE ${where} ORDER BY o.id DESC LIMIT 500`, params);
    const [summary] = await pool.execute(`
      SELECT COUNT(*) AS total_operations,
        COALESCE(SUM(CASE WHEN status IN ('PAID','BOARDED') AND payment_method='CASH' THEN fare_price ELSE 0 END),0) AS total_cash,
        SUM(CASE WHEN payment_method='EXEMPT' THEN 1 ELSE 0 END) AS exempt
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      JOIN journeys j ON j.id = o.journey_id
      WHERE ${where}
    `, params);
    res.json({ success: true, data: { local_date: localDate, summary: summary[0], operations: rows } });
  } catch (error) { next(error); }
});

router.get('/operations', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const { where, params } = operationWhereFromQuery(req.query, false);
    const [rows] = await pool.execute(`${operationsSelect} WHERE ${where} ORDER BY o.id DESC LIMIT 1000`, params);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/operations/export', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const { where, params } = operationWhereFromQuery(req.query, false);
    const [rows] = await pool.execute(`${operationsSelect} WHERE ${where} ORDER BY o.id DESC LIMIT 5000`, params);
    sendHtmlTableExport(res, {
      filename: `transdier-operaciones-${req.query.journey_from || req.query.from || 'reporte'}`,
      format: req.query.format === 'pdf' ? 'pdf' : 'excel',
      title: 'Reporte de tickets Transdier',
      rows,
      columns: [
        { header: 'Ticket', value: r => r.ticket_number || r.invoice_number },
        { header: 'Empresa', key: 'company_name' },
        { header: 'Ferry', key: 'ferry_name' },
        { header: 'Trayecto', key: 'route_name' },
        { header: 'Placa', key: 'normalized_plate' },
        { header: 'Categoría real', key: 'vehicle_category_name' },
        { header: 'Tipo / tarifa comercial', key: 'vehicle_type_name' },
        { header: 'Condición', value: r => condicionTexto(r.load_status) },
        { header: 'Valor', key: 'fare_price' },
        { header: 'Estado', value: r => estadoOperacionTexto(r.status) },
        { header: 'Registró', key: 'registered_by_name' },
        { header: 'Facturó', key: 'billed_by_name' },
        { header: 'Abrió trayecto', key: 'trip_opened_by_name' },
        { header: 'Fecha y hora UTC', key: 'created_at_utc' }
      ]
    });
  } catch (error) { next(error); }
});


function localMoney(value) {
  return centsToMoney(moneyToCents(value)).toFixed(2);
}

function normalizeFinancialQuery(query) {
  const today = todayColombiaRangeToUtc();
  const from = query.from || today.localDate;
  const requestedTo = query.to || from;
  const to = requestedTo < from ? from : requestedTo;
  const { startUtc, endUtc } = fromColombiaDateRangeToUtc(from, to);
  const ferryId = query.ferry_id ? Number(query.ferry_id) : null;
  return { from, to, startUtc, endUtc, ferryId: Number.isInteger(ferryId) && ferryId > 0 ? ferryId : null };
}

function expenseCategoryText(category) {
  return ({
    GASOLINA: 'Gasolina',
    NOMINA: 'Nómina',
    MANTENIMIENTO: 'Mantenimiento',
    REPUESTOS: 'Repuestos',
    ACEITE: 'Aceite',
    ALIMENTACION: 'Alimentación',
    TRANSPORTE: 'Transporte',
    VARIOS: 'Varios'
  })[category] || category || 'Varios';
}

function operationIncomeCents(operation) {
  return ['PAID', 'BOARDED'].includes(operation.status) && operation.payment_method === 'CASH'
    ? moneyToCents(operation.fare_price)
    : 0;
}

function pushCents(target, key, cents) {
  const internalKey = `_${key}_cents`;
  target[internalKey] = Number(target[internalKey] || 0) + Number(cents || 0);
}

function centsOf(target, key) {
  return Number(target?.[`_${key}_cents`] || 0);
}

function finalizeMoneyRow(row, keys) {
  const result = { ...row };
  for (const key of keys) {
    result[key] = centsToMoney(centsOf(result, key));
    delete result[`_${key}_cents`];
  }
  return result;
}

function sumInternalCents(rows, key) {
  return rows.reduce((sum, row) => sum + centsOf(row, key), 0);
}

function integrityCheck(name, actual, expected, type = 'money') {
  return {
    name,
    actual: type === 'money' ? centsToMoney(actual) : Number(actual),
    expected: type === 'money' ? centsToMoney(expected) : Number(expected),
    ok: Number(actual) === Number(expected)
  };
}

async function buildFinancialReport(query) {
  const { from, to, startUtc, endUtc, ferryId } = normalizeFinancialQuery(query);

  const journeyParams = [startUtc, endUtc];
  let journeyWhere = 'j.opened_at_utc BETWEEN ? AND ?';
  if (ferryId) { journeyWhere += ' AND j.ferry_id = ?'; journeyParams.push(ferryId); }

  const [journeys] = await pool.execute(`
    SELECT
      j.id,
      j.id AS journey_id,
      j.status AS journey_status,
      j.opened_at_utc,
      j.closed_at_utc,
      j.scheduled_close_at_utc,
      DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS local_date,
      DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
      f.id AS ferry_id,
      f.name AS ferry_name,
      c.business_name AS company_name,
      u.name AS opened_by_name
    FROM journeys j
    JOIN ferries f ON f.id = j.ferry_id
    JOIN companies c ON c.id = j.company_id
    JOIN users u ON u.id = j.opened_by_user_id
    WHERE ${journeyWhere}
    ORDER BY j.opened_at_utc DESC, f.name
  `, journeyParams);

  const tripParams = [startUtc, endUtc];
  let tripWhere = 'j.opened_at_utc BETWEEN ? AND ? AND t.deleted_at_utc IS NULL';
  if (ferryId) { tripWhere += ' AND t.ferry_id = ?'; tripParams.push(ferryId); }

  const [trips] = await pool.execute(`
    SELECT
      t.id,
      t.id AS trip_id,
      t.journey_id,
      t.route_id,
      t.status AS trip_status,
      t.opened_at_utc AS trip_opened_at_utc,
      t.closed_at_utc AS trip_closed_at_utc,
      t.opened_by_user_id,
      t.closed_by_user_id,
      DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
      f.id AS ferry_id,
      f.name AS ferry_name,
      c.business_name AS company_name,
      r.name AS route_name,
      ou.name AS trip_opened_by_name,
      cu.name AS trip_closed_by_name
    FROM trips t
    JOIN journeys j ON j.id = t.journey_id
    JOIN ferries f ON f.id = t.ferry_id
    JOIN companies c ON c.id = t.company_id
    JOIN routes r ON r.id = t.route_id
    JOIN users ou ON ou.id = t.opened_by_user_id
    LEFT JOIN users cu ON cu.id = t.closed_by_user_id
    WHERE ${tripWhere}
    ORDER BY j.opened_at_utc DESC, t.id DESC
  `, tripParams);

  const opParams = [startUtc, endUtc];
  let opWhere = `
    o.active_in_trip = 1
    AND o.status NOT IN ('ANNULLED','REMOVED')
    AND t.deleted_at_utc IS NULL
    AND j.opened_at_utc BETWEEN ? AND ?
  `;
  if (ferryId) { opWhere += ' AND o.ferry_id = ?'; opParams.push(ferryId); }

  const [operations] = await pool.execute(`
    ${operationsSelect}
    WHERE ${opWhere}
    ORDER BY j.opened_at_utc DESC, f.name, t.id DESC, o.id DESC
  `, opParams);

  const expenseParams = [startUtc, endUtc, startUtc, endUtc];
  let expenseWhere = `
    e.status = 'ACTIVE'
    AND (
      (e.journey_id IS NOT NULL AND j.opened_at_utc BETWEEN ? AND ?)
      OR (e.journey_id IS NULL AND e.expense_at_utc BETWEEN ? AND ?)
    )
    AND (e.trip_id IS NULL OR t.id IS NOT NULL)
  `;
  if (ferryId) { expenseWhere += ' AND e.ferry_id = ?'; expenseParams.push(ferryId); }

  const [expenses] = await pool.execute(`
    SELECT
      e.id,
      e.company_id,
      e.ferry_id,
      f.name AS ferry_name,
      c.business_name AS company_name,
      e.journey_id,
      DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
      e.trip_id,
      r.name AS route_name,
      e.category,
      e.description,
      e.amount,
      e.expense_at_utc,
      e.support_photo_path,
      u.name AS created_by_name
    FROM expenses e
    JOIN ferries f ON f.id = e.ferry_id
    JOIN companies c ON c.id = e.company_id
    JOIN users u ON u.id = e.created_by_user_id
    LEFT JOIN journeys j ON j.id = e.journey_id
    LEFT JOIN trips t ON t.id = e.trip_id AND t.deleted_at_utc IS NULL
    LEFT JOIN routes r ON r.id = t.route_id
    WHERE ${expenseWhere}
    ORDER BY e.expense_at_utc DESC, e.id DESC
  `, expenseParams);

  const byFerry = new Map();
  const byJourney = new Map();
  const byTrip = new Map();
  const byExpenseCategory = new Map();
  const byUser = new Map();
  const byUserTrip = new Map();
  const typeByTrip = new Map();
  const typeByUserTrip = new Map();
  const byVehicleType = new Map();
  const byVehicleCategory = new Map();

  function ensureFerry(row) {
    const key = String(row.ferry_id);
    if (!byFerry.has(key)) byFerry.set(key, {
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      company_name: row.company_name || '',
      journeys_total: 0,
      trips_total: 0,
      vehicles_total: 0,
      exempt_total: 0,
      _income_total_cents: 0,
      _expenses_total_cents: 0,
      _net_total_cents: 0
    });
    return byFerry.get(key);
  }

  function ensureJourney(row) {
    const journeyId = row.journey_id ?? row.id;
    if (!journeyId) return null;
    const key = `${journeyId}-${row.ferry_id}`;
    if (!byJourney.has(key)) byJourney.set(key, {
      journey_id: journeyId,
      journey_local_date: row.journey_local_date || row.local_date || '',
      journey_status: row.journey_status || row.status || '',
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      company_name: row.company_name || '',
      trips_total: 0,
      vehicles_total: 0,
      exempt_total: 0,
      _income_total_cents: 0,
      _expenses_total_cents: 0,
      _unassigned_expenses_total_cents: 0,
      _net_total_cents: 0
    });
    return byJourney.get(key);
  }

  function ensureTrip(row) {
    const tripId = row.trip_id ?? row.id;
    if (!tripId) return null;
    const key = String(tripId);
    if (!byTrip.has(key)) byTrip.set(key, {
      trip_id: tripId,
      journey_id: row.journey_id,
      journey_local_date: row.journey_local_date || '',
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      company_name: row.company_name || '',
      route_id: row.route_id || null,
      route_name: row.route_name || 'Trayecto',
      trip_status: row.trip_status || row.status || '',
      trip_opened_at_utc: row.trip_opened_at_utc || row.opened_at_utc || null,
      trip_closed_at_utc: row.trip_closed_at_utc || row.closed_at_utc || null,
      trip_opened_by_name: row.trip_opened_by_name || '',
      trip_closed_by_name: row.trip_closed_by_name || '',
      vehicles_total: 0,
      exempt_total: 0,
      _income_total_cents: 0,
      _expenses_total_cents: 0,
      _net_total_cents: 0,
      type_summary_text: 'Sin vehículos',
      types: []
    });
    return byTrip.get(key);
  }

  for (const journey of journeys) {
    ensureFerry(journey);
    ensureJourney(journey);
  }
  for (const trip of trips) {
    ensureFerry(trip);
    ensureJourney(trip);
    ensureTrip(trip);
  }

  for (const operation of operations) {
    const incomeCents = operationIncomeCents(operation);
    const isExempt = operation.payment_method === 'EXEMPT' ? 1 : 0;

    const ferry = ensureFerry(operation);
    ferry.vehicles_total += 1;
    ferry.exempt_total += isExempt;
    pushCents(ferry, 'income_total', incomeCents);

    const journey = ensureJourney(operation);
    if (journey) {
      journey.vehicles_total += 1;
      journey.exempt_total += isExempt;
      pushCents(journey, 'income_total', incomeCents);
    }

    const trip = ensureTrip(operation);
    if (trip) {
      trip.vehicles_total += 1;
      trip.exempt_total += isExempt;
      pushCents(trip, 'income_total', incomeCents);
    }

    const userKey = String(operation.billed_by_user_id || 'SIN_USUARIO');
    if (!byUser.has(userKey)) byUser.set(userKey, {
      user_id: operation.billed_by_user_id || null,
      user_name: operation.billed_by_name || 'Sin usuario',
      user_role: operation.billed_by_role || '',
      vehicles_total: 0,
      exempt_total: 0,
      _income_total_cents: 0
    });
    const user = byUser.get(userKey);
    user.vehicles_total += 1;
    user.exempt_total += isExempt;
    pushCents(user, 'income_total', incomeCents);

    const userTripKey = `${operation.journey_id}-${operation.ferry_id}-${operation.trip_id}-${userKey}`;
    if (!byUserTrip.has(userTripKey)) byUserTrip.set(userTripKey, {
      journey_id: operation.journey_id,
      journey_local_date: operation.journey_local_date,
      ferry_id: operation.ferry_id,
      ferry_name: operation.ferry_name,
      trip_id: operation.trip_id,
      route_name: operation.route_name,
      user_id: operation.billed_by_user_id || null,
      user_name: operation.billed_by_name || 'Sin usuario',
      user_role: operation.billed_by_role || '',
      vehicles_total: 0,
      exempt_total: 0,
      _income_total_cents: 0,
      trip_vehicles_total: 0,
      _trip_income_total_cents: 0,
      _journey_income_total_cents: 0,
      type_summary_text: 'Sin vehículos',
      trip_opened_at_utc: operation.trip_opened_at_utc,
      trip_closed_at_utc: operation.trip_closed_at_utc,
      types: []
    });
    const userTrip = byUserTrip.get(userTripKey);
    userTrip.vehicles_total += 1;
    userTrip.exempt_total += isExempt;
    pushCents(userTrip, 'income_total', incomeCents);

    const tripTypeKey = `${operation.trip_id}-${operation.vehicle_type_id}-${operation.load_status}`;
    if (!typeByTrip.has(tripTypeKey)) typeByTrip.set(tripTypeKey, {
      trip_key: String(operation.trip_id),
      vehicle_type_id: operation.vehicle_type_id,
      vehicle_type_name: operation.vehicle_type_name,
      vehicle_category_id: operation.vehicle_category_id,
      vehicle_category_name: operation.vehicle_category_name,
      vehicle_category_code: operation.vehicle_category_code,
      load_status: operation.load_status,
      qty: 0,
      exempt_total: 0,
      _total_cents: 0
    });
    const tripType = typeByTrip.get(tripTypeKey);
    tripType.qty += 1;
    tripType.exempt_total += isExempt;
    pushCents(tripType, 'total', incomeCents);

    const userTripTypeKey = `${userTripKey}-${operation.vehicle_type_id}-${operation.load_status}`;
    if (!typeByUserTrip.has(userTripTypeKey)) typeByUserTrip.set(userTripTypeKey, {
      user_trip_key: userTripKey,
      vehicle_type_id: operation.vehicle_type_id,
      vehicle_type_name: operation.vehicle_type_name,
      vehicle_category_id: operation.vehicle_category_id,
      vehicle_category_name: operation.vehicle_category_name,
      vehicle_category_code: operation.vehicle_category_code,
      load_status: operation.load_status,
      qty: 0,
      exempt_total: 0,
      _total_cents: 0
    });
    const userTripType = typeByUserTrip.get(userTripTypeKey);
    userTripType.qty += 1;
    userTripType.exempt_total += isExempt;
    pushCents(userTripType, 'total', incomeCents);

    const globalTypeKey = `${operation.vehicle_category_id}-${operation.vehicle_type_id}-${operation.load_status}`;
    if (!byVehicleType.has(globalTypeKey)) byVehicleType.set(globalTypeKey, {
      vehicle_type_id: operation.vehicle_type_id,
      vehicle_type_name: operation.vehicle_type_name,
      vehicle_category_id: operation.vehicle_category_id,
      vehicle_category_name: operation.vehicle_category_name,
      vehicle_category_code: operation.vehicle_category_code,
      load_status: operation.load_status,
      qty: 0,
      exempt_total: 0,
      _total_cents: 0
    });
    const vehicleType = byVehicleType.get(globalTypeKey);
    vehicleType.qty += 1;
    vehicleType.exempt_total += isExempt;
    pushCents(vehicleType, 'total', incomeCents);

    const categoryKey = String(operation.vehicle_category_id);
    if (!byVehicleCategory.has(categoryKey)) byVehicleCategory.set(categoryKey, {
      vehicle_category_id: operation.vehicle_category_id,
      vehicle_category_name: operation.vehicle_category_name,
      vehicle_category_code: operation.vehicle_category_code,
      qty: 0,
      exempt_total: 0,
      _total_cents: 0
    });
    const category = byVehicleCategory.get(categoryKey);
    category.qty += 1;
    category.exempt_total += isExempt;
    pushCents(category, 'total', incomeCents);
  }

  let generalExpensesCents = 0;
  let journeyLevelExpensesCents = 0;
  let tripExpensesCents = 0;

  for (const expense of expenses) {
    const amountCents = moneyToCents(expense.amount);
    const ferry = ensureFerry(expense);
    pushCents(ferry, 'expenses_total', amountCents);

    const journey = ensureJourney(expense);
    if (journey) pushCents(journey, 'expenses_total', amountCents);

    const trip = ensureTrip(expense);
    if (trip) {
      pushCents(trip, 'expenses_total', amountCents);
      tripExpensesCents += amountCents;
    } else if (journey) {
      pushCents(journey, 'unassigned_expenses_total', amountCents);
      journeyLevelExpensesCents += amountCents;
    } else {
      generalExpensesCents += amountCents;
    }

    const categoryKey = `${expense.category}-${expense.ferry_id}`;
    if (!byExpenseCategory.has(categoryKey)) byExpenseCategory.set(categoryKey, {
      category: expense.category,
      category_name: expenseCategoryText(expense.category),
      ferry_id: expense.ferry_id,
      ferry_name: expense.ferry_name,
      qty: 0,
      _total_cents: 0
    });
    const category = byExpenseCategory.get(categoryKey);
    category.qty += 1;
    pushCents(category, 'total', amountCents);
  }

  const tripTypesInternal = Array.from(typeByTrip.values());
  const userTripTypesInternal = Array.from(typeByUserTrip.values());

  for (const trip of byTrip.values()) {
    trip.types = tripTypesInternal
      .filter(type => type.trip_key === String(trip.trip_id))
      .map(type => finalizeMoneyRow(type, ['total']))
      .sort((a, b) => String(a.vehicle_category_name).localeCompare(String(b.vehicle_category_name), 'es') || String(a.vehicle_type_name).localeCompare(String(b.vehicle_type_name), 'es'));
    trip.type_summary_text = trip.types.length
      ? trip.types.map(type => `${type.qty} × ${type.vehicle_category_name || 'Sin categoría'} · ${type.vehicle_type_name}`).join(', ')
      : 'Sin vehículos';
  }

  for (const [key, userTrip] of byUserTrip.entries()) {
    const trip = byTrip.get(String(userTrip.trip_id));
    const journey = byJourney.get(`${userTrip.journey_id}-${userTrip.ferry_id}`);
    userTrip.trip_vehicles_total = Number(trip?.vehicles_total || 0);
    userTrip._trip_income_total_cents = centsOf(trip, 'income_total');
    userTrip._journey_income_total_cents = centsOf(journey, 'income_total');
    userTrip.types = userTripTypesInternal
      .filter(type => type.user_trip_key === key)
      .map(type => finalizeMoneyRow(type, ['total']))
      .sort((a, b) => String(a.vehicle_type_name).localeCompare(String(b.vehicle_type_name), 'es'));
    userTrip.type_summary_text = userTrip.types.length
      ? userTrip.types.map(type => `${type.qty} × ${type.vehicle_category_name || 'Sin categoría'} · ${type.vehicle_type_name}`).join(', ')
      : 'Sin vehículos';
  }

  for (const ferry of byFerry.values()) {
    ferry.journeys_total = journeys.filter(journey => Number(journey.ferry_id) === Number(ferry.ferry_id)).length;
    ferry.trips_total = trips.filter(trip => Number(trip.ferry_id) === Number(ferry.ferry_id)).length;
    ferry._net_total_cents = centsOf(ferry, 'income_total') - centsOf(ferry, 'expenses_total');
  }
  for (const journey of byJourney.values()) {
    journey.trips_total = trips.filter(trip => Number(trip.journey_id) === Number(journey.journey_id)).length;
    journey._net_total_cents = centsOf(journey, 'income_total') - centsOf(journey, 'expenses_total');
  }
  for (const trip of byTrip.values()) {
    trip._net_total_cents = centsOf(trip, 'income_total') - centsOf(trip, 'expenses_total');
  }

  const totalIncomeCents = operations.reduce((sum, operation) => sum + operationIncomeCents(operation), 0);
  const totalExpensesCents = expenses.reduce((sum, expense) => sum + moneyToCents(expense.amount), 0);
  const totalVehicles = operations.length;
  const totalExempt = operations.filter(operation => operation.payment_method === 'EXEMPT').length;

  const ferryRowsInternal = Array.from(byFerry.values());
  const journeyRowsInternal = Array.from(byJourney.values());
  const tripRowsInternal = Array.from(byTrip.values());
  const userRowsInternal = Array.from(byUser.values());
  const typeRowsInternal = Array.from(byVehicleType.values());
  const categoryRowsInternal = Array.from(byVehicleCategory.values());

  const checks = [
    integrityCheck('Ingresos = suma por ferry', sumInternalCents(ferryRowsInternal, 'income_total'), totalIncomeCents),
    integrityCheck('Ingresos = suma por jornada', sumInternalCents(journeyRowsInternal, 'income_total'), totalIncomeCents),
    integrityCheck('Ingresos = suma por trayecto', sumInternalCents(tripRowsInternal, 'income_total'), totalIncomeCents),
    integrityCheck('Ingresos = suma por operador que facturó', sumInternalCents(userRowsInternal, 'income_total'), totalIncomeCents),
    integrityCheck('Ingresos = suma por tipo de vehículo', sumInternalCents(typeRowsInternal, 'total'), totalIncomeCents),
    integrityCheck('Gastos = suma por ferry', sumInternalCents(ferryRowsInternal, 'expenses_total'), totalExpensesCents),
    integrityCheck('Gastos = jornadas + generales', sumInternalCents(journeyRowsInternal, 'expenses_total') + generalExpensesCents, totalExpensesCents),
    integrityCheck('Gastos = trayecto + jornada + generales', tripExpensesCents + journeyLevelExpensesCents + generalExpensesCents, totalExpensesCents),
    integrityCheck('Vehículos = suma por operador', userRowsInternal.reduce((sum, row) => sum + Number(row.vehicles_total || 0), 0), totalVehicles, 'count'),
    integrityCheck('Vehículos = suma por tipo', typeRowsInternal.reduce((sum, row) => sum + Number(row.qty || 0), 0), totalVehicles, 'count'),
    integrityCheck('Neto = suma por ferry', sumInternalCents(ferryRowsInternal, 'net_total'), totalIncomeCents - totalExpensesCents)
  ];

  const byFerryFinal = ferryRowsInternal
    .map(row => finalizeMoneyRow(row, ['income_total', 'expenses_total', 'net_total']))
    .sort((a, b) => String(a.ferry_name).localeCompare(String(b.ferry_name), 'es'));
  const byJourneyFinal = journeyRowsInternal
    .map(row => finalizeMoneyRow(row, ['income_total', 'expenses_total', 'unassigned_expenses_total', 'net_total']))
    .sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || String(a.ferry_name).localeCompare(String(b.ferry_name), 'es'));
  const byTripFinal = tripRowsInternal
    .map(row => finalizeMoneyRow(row, ['income_total', 'expenses_total', 'net_total']))
    .sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || Number(b.trip_id || 0) - Number(a.trip_id || 0));
  const byUserFinal = userRowsInternal
    .map(row => finalizeMoneyRow(row, ['income_total']))
    .sort((a, b) => moneyToCents(b.income_total) - moneyToCents(a.income_total) || String(a.user_name).localeCompare(String(b.user_name), 'es'));
  const byUserTripFinal = Array.from(byUserTrip.values())
    .map(row => finalizeMoneyRow(row, ['income_total', 'trip_income_total', 'journey_income_total']))
    .sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || Number(b.trip_id || 0) - Number(a.trip_id || 0) || String(a.user_name).localeCompare(String(b.user_name), 'es'));
  const byVehicleTypeFinal = typeRowsInternal
    .map(row => finalizeMoneyRow(row, ['total']))
    .sort((a, b) => String(a.vehicle_category_name).localeCompare(String(b.vehicle_category_name), 'es') || String(a.vehicle_type_name).localeCompare(String(b.vehicle_type_name), 'es') || String(a.load_status).localeCompare(String(b.load_status)));
  const byVehicleCategoryFinal = categoryRowsInternal
    .map(row => finalizeMoneyRow(row, ['total']))
    .sort((a, b) => String(a.vehicle_category_name).localeCompare(String(b.vehicle_category_name), 'es'));
  const byExpenseCategoryFinal = Array.from(byExpenseCategory.values())
    .map(row => finalizeMoneyRow(row, ['total']))
    .sort((a, b) => String(a.category_name).localeCompare(String(b.category_name), 'es') || String(a.ferry_name).localeCompare(String(b.ferry_name), 'es'));

  return {
    filter: { from, to, ferry_id: ferryId },
    summary: {
      income_total: centsToMoney(totalIncomeCents),
      expenses_total: centsToMoney(totalExpensesCents),
      net_total: centsToMoney(totalIncomeCents - totalExpensesCents),
      vehicles_total: totalVehicles,
      exempt_total: totalExempt,
      journeys_total: journeys.length,
      trips_total: trips.length,
      expenses_count: expenses.length,
      cash_operations_total: operations.filter(operation => operation.payment_method === 'CASH').length,
      boarded_total: operations.filter(operation => operation.status === 'BOARDED').length,
      pending_board_total: operations.filter(operation => ['PAID', 'EXEMPT'].includes(operation.status)).length,
      general_expenses_total: centsToMoney(generalExpensesCents),
      journey_level_expenses_total: centsToMoney(journeyLevelExpensesCents),
      trip_expenses_total: centsToMoney(tripExpensesCents)
    },
    integrity: {
      ok: checks.every(check => check.ok),
      checked_at_utc: new Date().toISOString(),
      checks
    },
    journeys,
    trips,
    by_ferry: byFerryFinal,
    by_journey: byJourneyFinal,
    by_trip: byTripFinal,
    by_expense_category: byExpenseCategoryFinal,
    by_user: byUserFinal,
    by_user_trip: byUserTripFinal,
    by_vehicle_type: byVehicleTypeFinal,
    by_vehicle_category: byVehicleCategoryFinal,
    operations,
    expenses
  };
}

function sanitizeReportForRole(report, role) {
  if (role !== 'SOCIO') return report;
  const visibleChecks = report.integrity.checks.filter(check => /Ingresos|Vehículos/.test(check.name));
  return {
    ...report,
    summary: {
      ...report.summary,
      expenses_total: 0,
      net_total: report.summary.income_total,
      expenses_count: 0,
      general_expenses_total: 0,
      journey_level_expenses_total: 0,
      trip_expenses_total: 0
    },
    integrity: {
      ...report.integrity,
      scope: 'INCOME_ONLY',
      checks: visibleChecks,
      ok: visibleChecks.every(check => check.ok)
    },
    by_ferry: report.by_ferry.map(row => ({ ...row, expenses_total: 0, net_total: row.income_total })),
    by_journey: report.by_journey.map(row => ({ ...row, expenses_total: 0, unassigned_expenses_total: 0, net_total: row.income_total })),
    by_trip: report.by_trip.map(row => ({ ...row, expenses_total: 0, net_total: row.income_total })),
    by_expense_category: [],
    expenses: []
  };
}

router.get('/financial', allowRoles('ADMIN', 'SECRETARIA', 'SOCIO'), async (req, res, next) => {
  try {
    const report = sanitizeReportForRole(await buildFinancialReport(req.query), req.user.role);
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});

router.get('/financial/export', allowRoles('ADMIN', 'SECRETARIA'), async (req, res, next) => {
  try {
    const report = await buildFinancialReport(req.query);
    const rows = [];
    const { summary, filter } = report;
    rows.push({ section: 'RESUMEN', concept: `Periodo ${filter.from} a ${filter.to}`, detail: '', qty: '', income: localMoney(summary.income_total), expenses: localMoney(summary.expenses_total), net: localMoney(summary.net_total), extra: `Vehículos: ${summary.vehicles_total} | Trayectos: ${summary.trips_total} | Jornadas: ${summary.journeys_total}` });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'POR FERRY', concept: 'Ferry', detail: 'Detalle', qty: 'Vehículos', income: 'Ingresos', expenses: 'Gastos', net: 'Neto', extra: 'Trayectos' });
    for (const r of report.by_ferry) rows.push({ section: 'TOTAL FERRY', concept: r.ferry_name, detail: '', qty: r.vehicles_total, income: localMoney(r.income_total), expenses: localMoney(r.expenses_total), net: localMoney(r.net_total), extra: `${r.trips_total} trayectos` });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'TOTAL DE JORNADA', concept: 'Jornada / Fecha', detail: 'Ferry', qty: 'Vehículos', income: 'Total ingresos jornada', expenses: 'Total gastos jornada', net: 'Total neto jornada', extra: 'Detalle' });
    for (const r of report.by_journey) rows.push({ section: 'TOTAL DE JORNADA', concept: `Jornada ${r.journey_local_date}`, detail: r.ferry_name, qty: r.vehicles_total, income: localMoney(r.income_total), expenses: localMoney(r.expenses_total), net: localMoney(r.net_total), extra: `${r.trips_total} trayectos | ${r.exempt_total || 0} tarifa 0` });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'TOTAL POR USUARIO', concept: 'Usuario que facturó', detail: 'Detalle', qty: 'Vehículos cobrados', income: 'Total cobrado', expenses: '', net: '', extra: 'Tarifa 0' });
    for (const u of report.by_user) rows.push({ section: 'TOTAL POR USUARIO', concept: u.user_name, detail: '', qty: u.vehicles_total, income: localMoney(u.income_total), expenses: '', net: '', extra: `${u.exempt_total || 0} tarifa 0` });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'CONSOLIDADO USUARIO/TRAYECTO', concept: 'Usuario / Trayecto', detail: 'Jornada / Ferry', qty: 'Vehículos cobrados', income: 'Total usuario en trayecto', expenses: '', net: 'Total trayecto', extra: 'Tipos / detalle' });
    for (const r of report.by_user_trip || []) rows.push({ section: 'CONSOLIDADO USUARIO/TRAYECTO', concept: `${r.user_name} · ${r.route_name}`, detail: `Jornada ${r.journey_local_date} · ${r.ferry_name} · Trayecto #${r.trip_id}`, qty: r.vehicles_total, income: localMoney(r.income_total), expenses: '', net: localMoney(r.trip_income_total), extra: `${r.type_summary_text} | Total jornada ${localMoney(r.journey_income_total)}` });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'TOTAL POR TRAYECTO', concept: 'Trayecto', detail: 'Ferry / Jornada', qty: 'Vehículos en trayecto', income: 'Total ingresos trayecto', expenses: 'Gastos asociados trayecto', net: 'Neto trayecto', extra: 'Vehículos por tipo' });
    for (const r of report.by_trip) rows.push({ section: 'TOTAL POR TRAYECTO', concept: `#${r.trip_id || '-'} · ${r.route_name}`, detail: `${r.ferry_name} · Jornada ${r.journey_local_date}`, qty: r.vehicles_total, income: localMoney(r.income_total), expenses: localMoney(r.expenses_total), net: localMoney(r.net_total), extra: r.type_summary_text });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'GASTOS', concept: 'Categoría', detail: 'Descripción/Ferry', qty: 'Cantidad', income: '', expenses: 'Valor', net: '', extra: 'Fecha' });
    for (const e of report.expenses) rows.push({ section: 'GASTOS', concept: expenseCategoryText(e.category), detail: `${e.description} · ${e.ferry_name}${e.route_name ? ' · ' + e.route_name : ''}`, qty: 1, income: '', expenses: localMoney(e.amount), net: '', extra: e.expense_at_utc });
    rows.push({ section: '', concept: '', detail: '', qty: '', income: '', expenses: '', net: '', extra: '' });

    rows.push({ section: 'TICKETS', concept: 'Ticket/Placa', detail: 'Trayecto/Ferry', qty: 'Tipo', income: 'Valor', expenses: '', net: '', extra: 'Registró / Facturó' });
    for (const o of report.operations) rows.push({ section: 'TICKETS', concept: `${o.ticket_number || o.invoice_number} · ${o.normalized_plate}`, detail: `${o.route_name} · ${o.ferry_name} · ${o.journey_local_date}`, qty: `${o.vehicle_category_name || 'Sin categoría'} · ${o.vehicle_type_name} · ${condicionTexto(o.load_status)}`, income: localMoney(o.payment_method === 'CASH' ? o.fare_price : 0), expenses: '', net: '', extra: `${o.registered_by_name} / ${o.billed_by_name}` });

    sendHtmlTableExport(res, {
      filename: `transdier-reporte-financiero-${filter.from}-${filter.to}`,
      format: req.query.format === 'pdf' ? 'pdf' : 'excel',
      title: `Reporte financiero Transdier ${filter.from} a ${filter.to}`,
      rows,
      columns: [
        { header: 'Sección', key: 'section' },
        { header: 'Concepto', key: 'concept' },
        { header: 'Detalle', key: 'detail' },
        { header: 'Cantidad', key: 'qty' },
        { header: 'Ingresos', key: 'income' },
        { header: 'Gastos', key: 'expenses' },
        { header: 'Neto', key: 'net' },
        { header: 'Extra', key: 'extra' }
      ]
    });
  } catch (error) { next(error); }
});



function buildCompleteExportRows(report, { includeExpenses = true } = {}) {
  const rows = [];
  const blank = () => rows.push({ section: '', group: '', concept: '', detail: '', quantity: '', income: '', expenses: '', net: '', responsible: '', date: '' });
  const { summary, filter } = report;

  rows.push({
    section: 'RESUMEN GENERAL',
    group: `${filter.from} a ${filter.to}`,
    concept: 'TOTAL DEL PERIODO',
    detail: `${summary.journeys_total} jornadas · ${summary.trips_total} trayectos · ${summary.exempt_total} tarifa 0`,
    quantity: summary.vehicles_total,
    income: localMoney(summary.income_total),
    expenses: includeExpenses ? localMoney(summary.expenses_total) : '',
    net: localMoney(includeExpenses ? summary.net_total : summary.income_total),
    responsible: '',
    date: ''
  });
  blank();

  for (const check of report.integrity.checks || []) {
    rows.push({
      section: 'VALIDACIÓN DE TOTALES',
      group: check.ok ? 'CORRECTO' : 'REVISAR',
      concept: check.name,
      detail: `Calculado: ${check.actual} · Esperado: ${check.expected}`,
      quantity: '', income: '', expenses: '', net: '', responsible: '', date: report.integrity.checked_at_utc
    });
  }
  blank();

  for (const ferry of report.by_ferry || []) {
    rows.push({
      section: 'TOTAL POR FERRY',
      group: ferry.company_name || '',
      concept: ferry.ferry_name,
      detail: `${ferry.journeys_total} jornadas · ${ferry.trips_total} trayectos · ${ferry.exempt_total || 0} tarifa 0`,
      quantity: ferry.vehicles_total,
      income: localMoney(ferry.income_total),
      expenses: includeExpenses ? localMoney(ferry.expenses_total) : '',
      net: localMoney(includeExpenses ? ferry.net_total : ferry.income_total),
      responsible: '',
      date: ''
    });
  }
  blank();

  for (const journey of report.by_journey || []) {
    rows.push({
      section: 'TOTAL POR JORNADA',
      group: `Jornada #${journey.journey_id}`,
      concept: `${journey.journey_local_date} · ${journey.ferry_name}`,
      detail: `${journey.trips_total} trayectos · ${journey.exempt_total || 0} tarifa 0${includeExpenses && Number(journey.unassigned_expenses_total || 0) ? ` · Gastos sin trayecto: ${localMoney(journey.unassigned_expenses_total)}` : ''}`,
      quantity: journey.vehicles_total,
      income: localMoney(journey.income_total),
      expenses: includeExpenses ? localMoney(journey.expenses_total) : '',
      net: localMoney(includeExpenses ? journey.net_total : journey.income_total),
      responsible: '',
      date: journey.journey_local_date
    });
  }
  blank();

  for (const user of report.by_user || []) {
    rows.push({
      section: 'TOTAL FACTURADO POR OPERADOR',
      group: user.user_role || 'USUARIO',
      concept: user.user_name,
      detail: `${user.exempt_total || 0} tarifa 0`,
      quantity: user.vehicles_total,
      income: localMoney(user.income_total),
      expenses: '', net: '', responsible: user.user_name, date: ''
    });
  }
  blank();

  for (const userTrip of report.by_user_trip || []) {
    rows.push({
      section: 'OPERADOR POR TRAYECTO',
      group: `Trayecto #${userTrip.trip_id} · Jornada #${userTrip.journey_id}`,
      concept: `${userTrip.user_name} · ${userTrip.route_name}`,
      detail: `${userTrip.ferry_name} · ${userTrip.type_summary_text} · Total completo del trayecto: ${localMoney(userTrip.trip_income_total)}`,
      quantity: userTrip.vehicles_total,
      income: localMoney(userTrip.income_total),
      expenses: '', net: '', responsible: userTrip.user_name, date: userTrip.journey_local_date
    });
  }
  blank();

  for (const type of report.by_vehicle_type || []) {
    rows.push({
      section: 'TOTAL POR TIPO DE VEHÍCULO',
      group: type.vehicle_category_name || 'Sin categoría',
      concept: type.vehicle_type_name,
      detail: `${condicionTexto(type.load_status)} · ${type.exempt_total || 0} tarifa 0`,
      quantity: type.qty,
      income: localMoney(type.total),
      expenses: '', net: '', responsible: '', date: ''
    });
  }
  blank();

  for (const trip of report.by_trip || []) {
    rows.push({
      section: 'TOTAL POR TRAYECTO',
      group: `Trayecto #${trip.trip_id}`,
      concept: `${trip.route_name} · ${trip.ferry_name}`,
      detail: `${trip.journey_local_date} · ${trip.type_summary_text}`,
      quantity: trip.vehicles_total,
      income: localMoney(trip.income_total),
      expenses: includeExpenses ? localMoney(trip.expenses_total) : '',
      net: localMoney(includeExpenses ? trip.net_total : trip.income_total),
      responsible: [trip.trip_opened_by_name && `Abrió: ${trip.trip_opened_by_name}`, trip.trip_closed_by_name && `Cerró: ${trip.trip_closed_by_name}`].filter(Boolean).join(' · '),
      date: trip.trip_closed_at_utc || trip.trip_opened_at_utc || ''
    });
  }
  blank();

  if (includeExpenses) {
    for (const category of report.by_expense_category || []) {
      rows.push({
        section: 'GASTOS POR CATEGORÍA',
        group: category.ferry_name,
        concept: category.category_name,
        detail: `${category.qty} movimiento(s)`,
        quantity: category.qty,
        income: '', expenses: localMoney(category.total), net: '', responsible: '', date: ''
      });
    }
    blank();

    for (const expense of report.expenses || []) {
      rows.push({
        section: 'DETALLE DE GASTOS',
        group: expense.ferry_name,
        concept: expenseCategoryText(expense.category),
        detail: `${expense.description}${expense.route_name ? ` · ${expense.route_name}` : ''}${expense.journey_id ? ` · Jornada #${expense.journey_id}` : ' · Gasto general'}`,
        quantity: 1,
        income: '', expenses: localMoney(expense.amount), net: '', responsible: expense.created_by_name, date: expense.expense_at_utc
      });
    }
    blank();
  }

  for (const operation of report.operations || []) {
    rows.push({
      section: 'DETALLE DE TICKETS',
      group: `Jornada #${operation.journey_id} · Trayecto #${operation.trip_id}`,
      concept: `${operation.ticket_number || operation.invoice_number} · ${operation.normalized_plate}`,
      detail: `${operation.ferry_name} · ${operation.route_name} · ${operation.vehicle_category_name || 'Sin categoría'} · ${operation.vehicle_type_name} · ${condicionTexto(operation.load_status)} · ${estadoOperacionTexto(operation.status)}`,
      quantity: 1,
      income: localMoney(centsToMoney(operationIncomeCents(operation))),
      expenses: '', net: '',
      responsible: `Registró: ${operation.registered_by_name} · Facturó: ${operation.billed_by_name}${operation.boarding_by_name ? ` · Embarcó: ${operation.boarding_by_name}` : ''}`,
      date: operation.created_at_utc
    });
  }

  return rows;
}

router.get('/complete/export', allowRoles('ADMIN', 'SECRETARIA', 'SOCIO'), async (req, res, next) => {
  try {
    const sourceReport = await buildFinancialReport(req.query);
    const report = sanitizeReportForRole(sourceReport, req.user.role);
    const includeExpenses = req.user.role !== 'SOCIO';
    const rows = buildCompleteExportRows(report, { includeExpenses });
    const { filter } = report;

    sendHtmlTableExport(res, {
      filename: `transdier-reporte-completo-${filter.from}-${filter.to}`,
      format: req.query.format === 'pdf' ? 'pdf' : 'excel',
      title: `Reporte completo Transdier ${filter.from} a ${filter.to}`,
      rows,
      columns: [
        { header: 'Sección', key: 'section' },
        { header: 'Grupo', key: 'group' },
        { header: 'Concepto', key: 'concept' },
        { header: 'Detalle', key: 'detail' },
        { header: 'Cantidad', key: 'quantity' },
        { header: 'Ingresos', key: 'income' },
        { header: 'Gastos', key: 'expenses' },
        { header: 'Neto', key: 'net' },
        { header: 'Responsable', key: 'responsible' },
        { header: 'Fecha / hora UTC', key: 'date' }
      ]
    });
  } catch (error) { next(error); }
});


function buildConsolidatedExportRows(report, isSocio) {
  const rows = [];
  const { summary, filter } = report;
  const userTripRows = report.by_user_trip || [];
  const journeys = report.by_journey || [];
  const trips = (report.by_trip || []).filter(t => t.trip_id);
  const tripKey = t => String(t.trip_id);
  const journeyKey = j => `${j.journey_id}-${j.ferry_id}`;
  const tripsByJourney = trips.reduce((acc, t) => {
    const key = `${t.journey_id}-${t.ferry_id}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const usersByTrip = userTripRows.reduce((acc, row) => {
    const key = String(row.trip_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  rows.push({
    section: 'CONSOLIDADO GENERAL',
    jornada: `${filter.from} a ${filter.to}`,
    ferry: '',
    usuario_trayecto: 'TOTAL PERIODO',
    vehiculos: summary.vehicles_total,
    ingresos: localMoney(summary.income_total),
    egresos: isSocio ? '' : localMoney(summary.expenses_total),
    total: localMoney(isSocio ? summary.income_total : summary.net_total),
    movimiento: 'TOTAL',
    fecha_hora: '',
    detalle: `Jornadas: ${summary.journeys_total} | Trayectos: ${summary.trips_total}`
  });
  rows.push({ section: '', jornada: '', ferry: '', usuario_trayecto: '', vehiculos: '', ingresos: '', egresos: '', total: '', movimiento: '', fecha_hora: '', detalle: '' });

  const orderedJourneys = journeys.slice().sort((a, b) => String(a.journey_local_date).localeCompare(String(b.journey_local_date)) || String(a.ferry_name).localeCompare(String(b.ferry_name)));
  for (const journey of orderedJourneys) {
    const jKey = journeyKey(journey);
    rows.push({
      section: 'JORNADA',
      jornada: journey.journey_local_date,
      ferry: journey.ferry_name,
      usuario_trayecto: `TOTAL JORNADA ${journey.journey_local_date}`,
      vehiculos: journey.vehicles_total,
      ingresos: localMoney(journey.income_total),
      egresos: isSocio ? '' : localMoney(journey.expenses_total),
      total: localMoney(isSocio ? journey.income_total : journey.net_total),
      movimiento: 'TOTAL JORNADA',
      fecha_hora: '',
      detalle: `${journey.trips_total} trayectos | ${journey.exempt_total || 0} tarifa 0`
    });

    const orderedTrips = (tripsByJourney[jKey] || []).slice().sort((a, b) => Number(a.trip_id || 0) - Number(b.trip_id || 0));
    for (const trip of orderedTrips) {
      const userRows = (usersByTrip[tripKey(trip)] || []).slice().sort((a, b) => String(a.user_name).localeCompare(String(b.user_name)));
      for (const row of userRows) {
        rows.push({
          section: 'INGRESO',
          jornada: row.journey_local_date,
          ferry: row.ferry_name,
          usuario_trayecto: `${row.user_name} · ${row.route_name}`,
          vehiculos: row.vehicles_total,
          ingresos: localMoney(row.income_total),
          egresos: '',
          total: localMoney(row.income_total),
          movimiento: 'INGRESO',
          fecha_hora: row.trip_closed_at_utc || row.trip_opened_at_utc || '',
          detalle: `Trayecto #${row.trip_id} | ${row.type_summary_text} | Total trayecto: ${localMoney(row.trip_income_total)}`
        });
      }
      rows.push({
        section: 'TOTAL TRAYECTO',
        jornada: trip.journey_local_date,
        ferry: trip.ferry_name,
        usuario_trayecto: `TOTAL TRAYECTO #${trip.trip_id} · ${trip.route_name}`,
        vehiculos: trip.vehicles_total,
        ingresos: localMoney(trip.income_total),
        egresos: isSocio ? '' : localMoney(trip.expenses_total),
        total: localMoney(isSocio ? trip.income_total : trip.net_total),
        movimiento: 'TOTAL TRAYECTO',
        fecha_hora: '',
        detalle: trip.type_summary_text
      });
    }
    rows.push({ section: '', jornada: '', ferry: '', usuario_trayecto: '', vehiculos: '', ingresos: '', egresos: '', total: '', movimiento: '', fecha_hora: '', detalle: '' });
  }

  rows.push({ section: 'RESUMEN FINAL', jornada: '', ferry: '', usuario_trayecto: 'INGRESOS', vehiculos: summary.vehicles_total, ingresos: localMoney(summary.income_total), egresos: '', total: localMoney(summary.income_total), movimiento: 'INGRESO', fecha_hora: '', detalle: 'Suma de todos los trayectos activos del rango' });
  if (!isSocio) rows.push({ section: 'RESUMEN FINAL', jornada: '', ferry: '', usuario_trayecto: 'EGRESOS', vehiculos: '', ingresos: '', egresos: localMoney(summary.expenses_total), total: localMoney(summary.expenses_total), movimiento: 'EGRESO', fecha_hora: '', detalle: 'Gastos activos del rango' });
  rows.push({ section: 'RESUMEN FINAL', jornada: '', ferry: '', usuario_trayecto: 'TOTAL REPORTADO', vehiculos: summary.vehicles_total, ingresos: localMoney(summary.income_total), egresos: isSocio ? '' : localMoney(summary.expenses_total), total: localMoney(isSocio ? summary.income_total : summary.net_total), movimiento: 'TOTAL', fecha_hora: '', detalle: 'Valor final reportado' });

  return rows;
}

router.get('/consolidated/export', allowRoles('ADMIN', 'SECRETARIA', 'SOCIO'), async (req, res, next) => {
  try {
    const report = await buildFinancialReport(req.query);
    const isSocio = req.user.role === 'SOCIO';
    const { filter } = report;
    const rows = buildConsolidatedExportRows(report, isSocio);

    sendHtmlTableExport(res, {
      filename: `transdier-consolidado-${filter.from}-${filter.to}`,
      format: req.query.format === 'pdf' ? 'pdf' : 'excel',
      title: `Consolidado Transdier ${filter.from} a ${filter.to}`,
      rows,
      columns: [
        { header: 'Sección', key: 'section' },
        { header: 'Jornada', key: 'jornada' },
        { header: 'Ferry', key: 'ferry' },
        { header: 'Usuario / Trayecto', key: 'usuario_trayecto' },
        { header: 'Vehículos', key: 'vehiculos' },
        { header: 'Ingresos', key: 'ingresos' },
        { header: 'Egresos', key: 'egresos' },
        { header: 'Total', key: 'total' },
        { header: 'Movimiento', key: 'movimiento' },
        { header: 'Fecha / Hora', key: 'fecha_hora' },
        { header: 'Detalle', key: 'detalle' }
      ]
    });
  } catch (error) { next(error); }
});

export default router;
