import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { fromColombiaDateRangeToUtc, todayColombiaRangeToUtc } from '../../utils/time.js';
import { sendHtmlTableExport } from '../../utils/exporters.js';

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
         u.name AS cashier_name, rb.name AS registered_by_name, bb.name AS billed_by_name,
         f.name AS ferry_name, c.business_name AS company_name, r.name AS route_name,
         DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
         t.opened_by_user_id, tu.name AS trip_opened_by_name, t.closed_by_user_id, tcu.name AS trip_closed_by_name
  FROM operations o
  JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
  JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
  JOIN users u ON u.id = o.cashier_user_id
  JOIN users rb ON rb.id = o.registered_by_user_id
  JOIN users bb ON bb.id = o.billed_by_user_id
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
    const requestedJourneyIds = parseIdList(req.query.journey_ids || req.query.journey_id);
    const hasJourneyFilter = requestedJourneyIds.length > 0;
    const todayRange = todayColombiaRangeToUtc();
    const dateFrom = req.query.from || todayRange.localDate;
    const dateTo = req.query.to || dateFrom;
    const { startUtc, endUtc } = fromColombiaDateRangeToUtc(dateFrom, dateTo);

    const opParams = [];
    let opFilter = "o.active_in_trip = 1 AND o.status NOT IN ('ANNULLED','REMOVED') AND t.deleted_at_utc IS NULL";
    if (hasJourneyFilter) {
      opFilter += ` AND o.journey_id IN ${inClause(requestedJourneyIds)}`;
      opParams.push(...requestedJourneyIds);
    } else {
      opFilter += ' AND j.opened_at_utc BETWEEN ? AND ?';
      opParams.push(startUtc, endUtc);
    }

    const expenseParams = [];
    let expenseFilter = "status = 'ACTIVE'";
    if (hasJourneyFilter) {
      expenseFilter += ` AND journey_id IN ${inClause(requestedJourneyIds)}`;
      expenseParams.push(...requestedJourneyIds);
    } else {
      expenseFilter += ' AND expense_at_utc BETWEEN ? AND ?';
      expenseParams.push(startUtc, endUtc);
    }

    const journeyFilter = hasJourneyFilter ? `j.id IN ${inClause(requestedJourneyIds)}` : 'j.opened_at_utc BETWEEN ? AND ?';
    const journeyFilterParams = hasJourneyFilter ? requestedJourneyIds : [startUtc, endUtc];

    const [journeyOptions] = await pool.execute(`
      SELECT j.id, j.status, j.opened_at_utc, j.closed_at_utc, j.scheduled_close_at_utc,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS local_date,
        f.id AS ferry_id, f.name AS ferry_name,
        u.name AS opened_by_name
      FROM journeys j
      JOIN ferries f ON f.id = j.ferry_id
      JOIN users u ON u.id = j.opened_by_user_id
      WHERE ${journeyFilter}
      ORDER BY j.opened_at_utc DESC
      LIMIT 90
    `, journeyFilterParams);

    const [openJourneys] = await pool.execute('SELECT COUNT(*) AS total FROM journeys WHERE status = \'OPEN\'');
    const [openTrips] = await pool.execute('SELECT COUNT(*) AS total FROM trips WHERE status = \'OPEN\' AND deleted_at_utc IS NULL');

    const [today] = await pool.execute(`
      SELECT COUNT(o.id) AS operations,
             COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS total_cash,
             0 AS boarded,
             SUM(CASE WHEN o.status IN ('PAID','EXEMPT') THEN 1 ELSE 0 END) AS pending_board,
             SUM(CASE WHEN o.payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      JOIN journeys j ON j.id = o.journey_id
      WHERE ${opFilter}
    `, opParams);

    const [expenses] = await pool.execute(`
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM expenses
      WHERE ${expenseFilter}
    `, expenseParams);

    const [byFerry] = await pool.execute(`
      SELECT f.id, f.name AS ferry_name,
        COALESCE(op.operations, 0) AS operations,
        COALESCE(op.income, 0) AS income,
        COALESCE(ex.total_expenses, 0) AS expenses,
        COALESCE(op.income, 0) - COALESCE(ex.total_expenses, 0) AS net
      FROM ferries f
      LEFT JOIN (
        SELECT o.ferry_id,
          COUNT(o.id) AS operations,
          COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS income
        FROM operations o
        JOIN trips t ON t.id = o.trip_id
        JOIN journeys j ON j.id = o.journey_id
        WHERE ${opFilter}
        GROUP BY o.ferry_id
      ) op ON op.ferry_id = f.id
      LEFT JOIN (
        SELECT ferry_id, SUM(amount) AS total_expenses FROM expenses WHERE ${expenseFilter} GROUP BY ferry_id
      ) ex ON ex.ferry_id = f.id
      WHERE f.deleted_at_utc IS NULL
      ORDER BY f.name
    `, [...opParams, ...expenseParams]);

    const [journeyFerryTotals] = await pool.execute(`
      SELECT
        j.id AS journey_id,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS local_date,
        j.status AS journey_status,
        f.id AS ferry_id,
        f.name AS ferry_name,
        COUNT(o.id) AS vehicles_total,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS income_total,
        SUM(CASE WHEN o.payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt_total
      FROM journeys j
      JOIN ferries f ON f.id = j.ferry_id
      LEFT JOIN operations o ON o.journey_id = j.id
        AND o.active_in_trip = 1
        AND o.status NOT IN ('ANNULLED','REMOVED')
        AND EXISTS (SELECT 1 FROM trips tx WHERE tx.id = o.trip_id AND tx.deleted_at_utc IS NULL)
      WHERE ${journeyFilter}
      GROUP BY j.id, local_date, j.status, f.id, f.name
      ORDER BY j.opened_at_utc DESC, f.name
    `, journeyFilterParams);

    const [tripTypeTotals] = await pool.execute(`
      SELECT
        o.journey_id,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
        o.trip_id,
        t.route_id,
        r.name AS route_name,
        f.id AS ferry_id,
        f.name AS ferry_name,
        o.vehicle_type_id,
        vt.name AS vehicle_type_name,
        o.vehicle_category_id,
        vc.name AS vehicle_category_name,
        vc.code AS vehicle_category_code,
        o.load_status,
        COUNT(o.id) AS qty,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS total
      FROM operations o
      JOIN journeys j ON j.id = o.journey_id
      JOIN trips t ON t.id = o.trip_id
      JOIN routes r ON r.id = t.route_id
      JOIN ferries f ON f.id = o.ferry_id
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      WHERE ${opFilter}
      GROUP BY o.journey_id, journey_local_date, o.trip_id, t.route_id, r.name, f.id, f.name,
        o.vehicle_type_id, vt.name, o.vehicle_category_id, vc.name, vc.code, o.load_status
      ORDER BY journey_local_date DESC, f.name, o.trip_id DESC, vt.name, o.load_status
    `, opParams);

    const [journeyFerryTypeTotals] = await pool.execute(`
      SELECT
        o.journey_id,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
        f.id AS ferry_id,
        f.name AS ferry_name,
        o.vehicle_type_id,
        vt.name AS vehicle_type_name,
        o.vehicle_category_id,
        vc.name AS vehicle_category_name,
        vc.code AS vehicle_category_code,
        o.load_status,
        COUNT(o.id) AS qty,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS total
      FROM operations o
      JOIN journeys j ON j.id = o.journey_id
      JOIN trips t ON t.id = o.trip_id
      JOIN ferries f ON f.id = o.ferry_id
      JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      WHERE ${opFilter}
      GROUP BY o.journey_id, journey_local_date, f.id, f.name,
        o.vehicle_type_id, vt.name, o.vehicle_category_id, vc.name, vc.code, o.load_status
      ORDER BY journey_local_date DESC, f.name, vt.name, o.load_status
    `, opParams);

    const [categoryTotals] = await pool.execute(`
      SELECT
        o.vehicle_category_id,
        vc.code AS vehicle_category_code,
        vc.name AS vehicle_category_name,
        COUNT(o.id) AS qty,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS total
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      JOIN journeys j ON j.id = o.journey_id
      JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
      WHERE ${opFilter}
      GROUP BY o.vehicle_category_id, vc.code, vc.name
      ORDER BY vc.name
    `, opParams);

    const [billedByTotals] = await pool.execute(`
      SELECT
        o.billed_by_user_id AS user_id,
        u.name AS user_name,
        u.role AS user_role,
        COUNT(o.id) AS vehicles_total,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS income_total,
        SUM(CASE WHEN o.payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt_total
      FROM operations o
      JOIN trips t ON t.id = o.trip_id
      JOIN journeys j ON j.id = o.journey_id
      JOIN users u ON u.id = o.billed_by_user_id
      WHERE ${opFilter}
      GROUP BY o.billed_by_user_id, u.name, u.role
      ORDER BY income_total DESC, vehicles_total DESC, u.name
    `, opParams);

    const [dashboardOperations] = await pool.execute(`
      ${operationsSelect}
      WHERE ${opFilter}
      ORDER BY j.opened_at_utc DESC, o.trip_id DESC, o.id DESC
      LIMIT 5000
    `, opParams);

    res.json({
      success: true,
      data: {
        filter_mode: hasJourneyFilter ? 'journeys' : (dateFrom === dateTo ? 'date' : 'range'),
        filter_from: dateFrom,
        filter_to: dateTo,
        selected_journey_ids: requestedJourneyIds,
        journey_options: journeyOptions,
        open_journeys: openJourneys[0].total,
        open_trips: openTrips[0].total,
        total_expenses: expenses[0].total_expenses,
        net_today: Number(today[0].total_cash || 0) - Number(expenses[0].total_expenses || 0),
        ...today[0],
        by_ferry: byFerry,
        journey_ferry_totals: journeyFerryTotals,
        journey_ferry_type_totals: journeyFerryTypeTotals,
        trip_type_totals: tripTypeTotals,
        category_totals: categoryTotals,
        operations_detail: dashboardOperations,
        billed_by_totals: billedByTotals
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


router.get('/travel-history', async (req, res, next) => {
  try {
    const canSeeAll = req.user.role === 'ADMIN';
    const today = todayColombiaRangeToUtc();
    const from = canSeeAll ? (req.query.from || today.localDate) : today.localDate;
    const to = canSeeAll ? (req.query.to || from) : from;
    const { startUtc, endUtc } = fromColombiaDateRangeToUtc(from, to);
    const ferryId = canSeeAll && req.query.ferry_id ? Number(req.query.ferry_id) : null;
    const ownUserId = canSeeAll ? null : Number(req.user.id);

    const baseParams = [startUtc, endUtc];
    let baseWhere = "j.opened_at_utc BETWEEN ? AND ? AND t.deleted_at_utc IS NULL";
    if (ferryId) { baseWhere += ' AND t.ferry_id = ?'; baseParams.push(ferryId); }
    if (ownUserId) {
      baseWhere += ` AND (
        t.opened_by_user_id = ?
        OR EXISTS (
          SELECT 1 FROM operations ox
          WHERE ox.trip_id = t.id
            AND ox.active_in_trip = 1
            AND ox.status NOT IN ('ANNULLED','REMOVED')
            AND (ox.registered_by_user_id = ? OR ox.billed_by_user_id = ?)
        )
      )`;
      baseParams.push(ownUserId, ownUserId, ownUserId);
    }

    const opJoinUserFilter = ownUserId ? ' AND (o.registered_by_user_id = ? OR o.billed_by_user_id = ?)' : '';
    const tripParams = ownUserId ? [...baseParams, ownUserId, ownUserId] : baseParams;

    const [trips] = await pool.execute(`
      SELECT
        t.id,
        t.status,
        t.opened_at_utc,
        t.closed_at_utc,
        t.journey_id,
        DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
        f.id AS ferry_id,
        f.name AS ferry_name,
        r.name AS route_name,
        r.origin_name,
        r.destination_name,
        ou.name AS opened_by_name,
        cu.name AS closed_by_name,
        COUNT(o.id) AS operations_total,
        COALESCE(SUM(CASE WHEN o.status IN ('PAID','BOARDED') AND o.payment_method = 'CASH' THEN o.fare_price ELSE 0 END), 0) AS income_total,
        SUM(CASE WHEN o.payment_method = 'EXEMPT' THEN 1 ELSE 0 END) AS exempt_total
      FROM trips t
      JOIN journeys j ON j.id = t.journey_id
      JOIN ferries f ON f.id = t.ferry_id
      JOIN routes r ON r.id = t.route_id
      JOIN users ou ON ou.id = t.opened_by_user_id
      LEFT JOIN users cu ON cu.id = t.closed_by_user_id
      LEFT JOIN operations o ON o.trip_id = t.id
        AND o.active_in_trip = 1
        AND o.status NOT IN ('ANNULLED','REMOVED')
        ${opJoinUserFilter}
      WHERE ${baseWhere}
      GROUP BY t.id, t.status, t.opened_at_utc, t.closed_at_utc, t.journey_id, journey_local_date,
        f.id, f.name, r.name, r.origin_name, r.destination_name, ou.name, cu.name
      ORDER BY j.opened_at_utc DESC, t.id DESC
      LIMIT 1000
    `, tripParams);

    const opParams = [startUtc, endUtc];
    let opWhere = `o.active_in_trip = 1
        AND o.status NOT IN ('ANNULLED','REMOVED')
        AND t.deleted_at_utc IS NULL
        AND j.opened_at_utc BETWEEN ? AND ?`;
    if (ferryId) { opWhere += ' AND o.ferry_id = ?'; opParams.push(ferryId); }
    if (ownUserId) { opWhere += ' AND (o.registered_by_user_id = ? OR o.billed_by_user_id = ?)'; opParams.push(ownUserId, ownUserId); }

    const [operations] = await pool.execute(`
      ${operationsSelect}
      WHERE ${opWhere}
      ORDER BY j.opened_at_utc DESC, o.trip_id DESC, o.id DESC
      LIMIT 5000
    `, opParams);

    const operationsByTrip = operations.reduce((acc, op) => {
      const key = String(op.trip_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(op);
      return acc;
    }, {});

    const journeyIds = new Set(trips.map(t => String(t.journey_id)));
    const summary = trips.reduce((acc, trip) => {
      acc.trips_total += 1;
      acc.vehicles_total += Number(trip.operations_total || 0);
      acc.income_total += Number(trip.income_total || 0);
      acc.exempt_total += Number(trip.exempt_total || 0);
      return acc;
    }, { journeys_total: journeyIds.size, trips_total: 0, vehicles_total: 0, income_total: 0, exempt_total: 0 });

    const byJourney = Array.from(trips.reduce((map, trip) => {
      const key = `${trip.journey_id}-${trip.ferry_id}`;
      if (!map.has(key)) map.set(key, {
        journey_id: trip.journey_id,
        journey_local_date: trip.journey_local_date,
        ferry_id: trip.ferry_id,
        ferry_name: trip.ferry_name,
        trips_total: 0,
        vehicles_total: 0,
        income_total: 0,
        exempt_total: 0
      });
      const row = map.get(key);
      row.trips_total += 1;
      row.vehicles_total += Number(trip.operations_total || 0);
      row.income_total += Number(trip.income_total || 0);
      row.exempt_total += Number(trip.exempt_total || 0);
      return map;
    }, new Map()).values());

    res.json({
      success: true,
      data: {
        filter: { from, to, ferry_id: ferryId, forced_today: !canSeeAll, own_user_only: !!ownUserId },
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
  return Number(value || 0).toFixed(2);
}

function pushAmount(target, key, amount) {
  target[key] = Number(target[key] || 0) + Number(amount || 0);
}

function normalizeFinancialQuery(query) {
  const today = todayColombiaRangeToUtc();
  const from = query.from || today.localDate;
  const to = query.to || from;
  const { startUtc, endUtc } = fromColombiaDateRangeToUtc(from, to);
  const ferryId = query.ferry_id ? Number(query.ferry_id) : null;
  return { from, to, startUtc, endUtc, ferryId };
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

async function buildFinancialReport(query) {
  const { from, to, startUtc, endUtc, ferryId } = normalizeFinancialQuery(query);
  const opParams = [startUtc, endUtc];
  let opWhere = `
    o.active_in_trip = 1
    AND o.status NOT IN ('ANNULLED','REMOVED')
    AND t.deleted_at_utc IS NULL
    AND j.opened_at_utc BETWEEN ? AND ?
  `;
  if (ferryId) { opWhere += ' AND o.ferry_id = ?'; opParams.push(ferryId); }

  const expenseParams = [startUtc, endUtc];
  let expenseWhere = `
    e.status = 'ACTIVE'
    AND e.expense_at_utc BETWEEN ? AND ?
    AND (e.trip_id IS NULL OR t.id IS NOT NULL)
  `;
  if (ferryId) { expenseWhere += ' AND e.ferry_id = ?'; expenseParams.push(ferryId); }

  const [operations] = await pool.execute(`
    SELECT
      o.id,
      o.ticket_number,
      o.invoice_number,
      o.normalized_plate,
      o.display_plate,
      o.vehicle_type_id,
      vt.name AS vehicle_type_name,
      o.vehicle_category_id,
      vc.name AS vehicle_category_name,
      vc.code AS vehicle_category_code,
      o.load_status,
      o.fare_price,
      o.payment_method,
      o.status,
      o.created_at_utc,
      j.id AS journey_id,
      DATE_FORMAT(CONVERT_TZ(j.opened_at_utc, '+00:00', '-05:00'), '%Y-%m-%d') AS journey_local_date,
      f.id AS ferry_id,
      f.name AS ferry_name,
      c.business_name AS company_name,
      t.id AS trip_id,
      t.status AS trip_status,
      t.opened_at_utc AS trip_opened_at_utc,
      t.closed_at_utc AS trip_closed_at_utc,
      r.name AS route_name,
      o.registered_by_user_id,
      o.billed_by_user_id,
      o.cashier_user_id,
      rb.name AS registered_by_name,
      bb.name AS billed_by_name,
      tu.name AS trip_opened_by_name,
      tcu.name AS trip_closed_by_name
    FROM operations o
    JOIN vehicle_types vt ON vt.id = o.vehicle_type_id
    JOIN vehicle_categories vc ON vc.id = o.vehicle_category_id
    JOIN ferries f ON f.id = o.ferry_id
    JOIN companies c ON c.id = o.company_id
    JOIN journeys j ON j.id = o.journey_id
    JOIN trips t ON t.id = o.trip_id
    JOIN routes r ON r.id = t.route_id
    JOIN users rb ON rb.id = o.registered_by_user_id
    JOIN users bb ON bb.id = o.billed_by_user_id
    LEFT JOIN users tu ON tu.id = t.opened_by_user_id
    LEFT JOIN users tcu ON tcu.id = t.closed_by_user_id
    WHERE ${opWhere}
    ORDER BY j.opened_at_utc DESC, f.name, t.id DESC, o.id DESC
    LIMIT 10000
  `, opParams);

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
    LIMIT 10000
  `, expenseParams);

  const byFerry = new Map();
  const byJourney = new Map();
  const byTrip = new Map();
  const byExpenseCategory = new Map();
  const byUser = new Map();
  const typeByTrip = new Map();
  const byUserTrip = new Map();
  const typeByUserTrip = new Map();
  const journeyIds = new Set();
  const tripIds = new Set();

  function ferryKey(row) { return String(row.ferry_id); }
  function ensureFerry(row) {
    const key = ferryKey(row);
    if (!byFerry.has(key)) byFerry.set(key, {
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      vehicles_total: 0,
      income_total: 0,
      expenses_total: 0,
      net_total: 0,
      exempt_total: 0,
      trips_total: 0
    });
    return byFerry.get(key);
  }
  function journeyKey(row) { return `${row.journey_id || 'SIN'}-${row.ferry_id}`; }
  function ensureJourney(row) {
    const key = journeyKey(row);
    if (!byJourney.has(key)) byJourney.set(key, {
      journey_id: row.journey_id || null,
      journey_local_date: row.journey_local_date || 'Sin jornada',
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      vehicles_total: 0,
      income_total: 0,
      expenses_total: 0,
      net_total: 0,
      exempt_total: 0,
      trips_total: 0
    });
    return byJourney.get(key);
  }
  function tripKey(row) { return String(row.trip_id || 'SIN_TRAYECTO_' + row.ferry_id); }
  function ensureTrip(row) {
    const key = tripKey(row);
    if (!byTrip.has(key)) byTrip.set(key, {
      trip_id: row.trip_id || null,
      journey_id: row.journey_id || null,
      journey_local_date: row.journey_local_date || 'Sin jornada',
      ferry_id: row.ferry_id,
      ferry_name: row.ferry_name,
      route_name: row.route_name || 'Gasto general',
      trip_status: row.trip_status || '',
      trip_opened_by_name: row.trip_opened_by_name || '',
      trip_closed_by_name: row.trip_closed_by_name || '',
      vehicles_total: 0,
      income_total: 0,
      expenses_total: 0,
      net_total: 0,
      exempt_total: 0,
      type_summary_text: '',
      types: []
    });
    return byTrip.get(key);
  }

  for (const o of operations) {
    const income = ['PAID', 'BOARDED'].includes(o.status) && o.payment_method === 'CASH' ? Number(o.fare_price || 0) : 0;
    const isExempt = o.payment_method === 'EXEMPT' ? 1 : 0;
    journeyIds.add(String(o.journey_id));
    tripIds.add(String(o.trip_id));

    const ferry = ensureFerry(o);
    ferry.vehicles_total += 1;
    ferry.exempt_total += isExempt;
    pushAmount(ferry, 'income_total', income);

    const journey = ensureJourney(o);
    journey.vehicles_total += 1;
    journey.exempt_total += isExempt;
    pushAmount(journey, 'income_total', income);

    const trip = ensureTrip(o);
    trip.vehicles_total += 1;
    trip.exempt_total += isExempt;
    pushAmount(trip, 'income_total', income);

    const userKey = String(o.billed_by_user_id || o.registered_by_user_id || 'SIN_USUARIO');
    if (!byUser.has(userKey)) byUser.set(userKey, {
      user_id: o.billed_by_user_id || o.registered_by_user_id || null,
      user_name: o.billed_by_name || o.registered_by_name || 'Sin usuario',
      vehicles_total: 0,
      income_total: 0,
      exempt_total: 0
    });
    const userTotal = byUser.get(userKey);
    userTotal.vehicles_total += 1;
    userTotal.exempt_total += isExempt;
    pushAmount(userTotal, 'income_total', income);

    const tk = tripKey(o);
    const userTripKey = `${o.journey_id}-${o.ferry_id}-${o.trip_id}-${userKey}`;
    if (!byUserTrip.has(userTripKey)) byUserTrip.set(userTripKey, {
      journey_id: o.journey_id,
      journey_local_date: o.journey_local_date,
      ferry_id: o.ferry_id,
      ferry_name: o.ferry_name,
      trip_id: o.trip_id,
      route_name: o.route_name,
      user_id: o.billed_by_user_id || o.registered_by_user_id || null,
      user_name: o.billed_by_name || o.registered_by_name || 'Sin usuario',
      vehicles_total: 0,
      income_total: 0,
      exempt_total: 0,
      trip_vehicles_total: 0,
      trip_income_total: 0,
      journey_income_total: 0,
      type_summary_text: '',
      trip_opened_at_utc: o.trip_opened_at_utc,
      trip_closed_at_utc: o.trip_closed_at_utc
    });
    const userTrip = byUserTrip.get(userTripKey);
    userTrip.vehicles_total += 1;
    userTrip.exempt_total += isExempt;
    pushAmount(userTrip, 'income_total', income);

    const userTripTypeKey = `${userTripKey}-${o.vehicle_type_id}-${o.load_status}`;
    if (!typeByUserTrip.has(userTripTypeKey)) typeByUserTrip.set(userTripTypeKey, {
      user_trip_key: userTripKey,
      vehicle_type_id: o.vehicle_type_id,
      vehicle_type_name: o.vehicle_type_name,
      vehicle_category_id: o.vehicle_category_id,
      vehicle_category_name: o.vehicle_category_name,
      vehicle_category_code: o.vehicle_category_code,
      load_status: o.load_status,
      qty: 0,
      total: 0
    });
    const userTripType = typeByUserTrip.get(userTripTypeKey);
    userTripType.qty += 1;
    pushAmount(userTripType, 'total', income);

    const tk2 = tk;
    const typeKey = `${tk2}-${o.vehicle_type_id}-${o.load_status}`;
    if (!typeByTrip.has(typeKey)) typeByTrip.set(typeKey, {
      trip_key: tk2,
      vehicle_type_id: o.vehicle_type_id,
      vehicle_type_name: o.vehicle_type_name,
      vehicle_category_id: o.vehicle_category_id,
      vehicle_category_name: o.vehicle_category_name,
      vehicle_category_code: o.vehicle_category_code,
      load_status: o.load_status,
      qty: 0,
      total: 0
    });
    const typeRow = typeByTrip.get(typeKey);
    typeRow.qty += 1;
    pushAmount(typeRow, 'total', income);
  }

  for (const e of expenses) {
    const amount = Number(e.amount || 0);
    const ferry = ensureFerry(e);
    pushAmount(ferry, 'expenses_total', amount);

    const journey = ensureJourney(e);
    pushAmount(journey, 'expenses_total', amount);
    if (e.journey_id) journeyIds.add(String(e.journey_id));

    const trip = ensureTrip(e);
    pushAmount(trip, 'expenses_total', amount);
    if (e.trip_id) tripIds.add(String(e.trip_id));

    const catKey = `${e.category}-${e.ferry_id}`;
    if (!byExpenseCategory.has(catKey)) byExpenseCategory.set(catKey, {
      category: e.category,
      category_name: expenseCategoryText(e.category),
      ferry_id: e.ferry_id,
      ferry_name: e.ferry_name,
      qty: 0,
      total: 0
    });
    const cat = byExpenseCategory.get(catKey);
    cat.qty += 1;
    pushAmount(cat, 'total', amount);
  }

  for (const row of byFerry.values()) row.net_total = Number(row.income_total || 0) - Number(row.expenses_total || 0);
  for (const row of byJourney.values()) row.net_total = Number(row.income_total || 0) - Number(row.expenses_total || 0);
  for (const row of byTrip.values()) row.net_total = Number(row.income_total || 0) - Number(row.expenses_total || 0);

  const tripTypes = Array.from(typeByTrip.values());
  for (const row of byTrip.values()) {
    row.types = tripTypes.filter(t => t.trip_key === String(row.trip_id || 'SIN_TRAYECTO_' + row.ferry_id));
    row.type_summary_text = row.types.length
      ? row.types.map(t => `${t.qty} × ${t.vehicle_category_name || 'Sin categoría'} · ${t.vehicle_type_name}`).join(', ')
      : 'Sin vehículos';
  }

  const tripTotalsById = new Map(Array.from(byTrip.values()).map(t => [String(t.trip_id || 'SIN_TRAYECTO_' + t.ferry_id), t]));
  const journeyTotalsByKey = new Map(Array.from(byJourney.values()).map(j => [`${j.journey_id || 'SIN'}-${j.ferry_id}`, j]));
  const userTripTypes = Array.from(typeByUserTrip.values());
  for (const [key, row] of byUserTrip.entries()) {
    const tripTotal = tripTotalsById.get(String(row.trip_id));
    const journeyTotal = journeyTotalsByKey.get(`${row.journey_id}-${row.ferry_id}`);
    row.trip_vehicles_total = Number(tripTotal?.vehicles_total || 0);
    row.trip_income_total = Number(tripTotal?.income_total || 0);
    row.journey_income_total = Number(journeyTotal?.income_total || 0);
    row.types = userTripTypes.filter(t => t.user_trip_key === key);
    row.type_summary_text = row.types.length
      ? row.types.map(t => `${t.qty} × ${t.vehicle_category_name || 'Sin categoría'} · ${t.vehicle_type_name}`).join(', ')
      : 'Sin vehículos';
  }

  for (const row of byFerry.values()) {
    row.trips_total = Array.from(byTrip.values()).filter(t => t.ferry_id === row.ferry_id && t.trip_id).length;
  }
  for (const row of byJourney.values()) {
    row.trips_total = Array.from(byTrip.values()).filter(t => t.journey_id === row.journey_id && t.ferry_id === row.ferry_id && t.trip_id).length;
  }

  const totalIncome = operations.reduce((acc, o) => acc + (['PAID', 'BOARDED'].includes(o.status) && o.payment_method === 'CASH' ? Number(o.fare_price || 0) : 0), 0);
  const totalExpenses = expenses.reduce((acc, e) => acc + Number(e.amount || 0), 0);
  const exemptTotal = operations.filter(o => o.payment_method === 'EXEMPT').length;

  return {
    filter: { from, to, ferry_id: ferryId },
    summary: {
      income_total: totalIncome,
      expenses_total: totalExpenses,
      net_total: totalIncome - totalExpenses,
      vehicles_total: operations.length,
      exempt_total: exemptTotal,
      journeys_total: journeyIds.size,
      trips_total: tripIds.size,
      expenses_count: expenses.length
    },
    by_ferry: Array.from(byFerry.values()).sort((a, b) => String(a.ferry_name).localeCompare(String(b.ferry_name))),
    by_journey: Array.from(byJourney.values()).sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || String(a.ferry_name).localeCompare(String(b.ferry_name))),
    by_trip: Array.from(byTrip.values()).sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || Number(b.trip_id || 0) - Number(a.trip_id || 0)),
    by_expense_category: Array.from(byExpenseCategory.values()).sort((a, b) => String(a.category_name).localeCompare(String(b.category_name))),
    by_user: Array.from(byUser.values()).sort((a, b) => Number(b.income_total || 0) - Number(a.income_total || 0)),
    by_user_trip: Array.from(byUserTrip.values()).sort((a, b) => String(b.journey_local_date).localeCompare(String(a.journey_local_date)) || Number(a.trip_id || 0) - Number(b.trip_id || 0) || String(a.user_name).localeCompare(String(b.user_name))),
    operations,
    expenses
  };
}

function sanitizeReportForRole(report, role) {
  if (role !== 'SOCIO') return report;
  return {
    ...report,
    summary: {
      ...report.summary,
      expenses_total: 0,
      net_total: report.summary.income_total,
      expenses_count: 0
    },
    by_ferry: report.by_ferry.map(r => ({ ...r, expenses_total: 0, net_total: r.income_total })),
    by_journey: report.by_journey.map(r => ({ ...r, expenses_total: 0, net_total: r.income_total })),
    by_trip: report.by_trip.map(r => ({ ...r, expenses_total: 0, net_total: r.income_total })),
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
