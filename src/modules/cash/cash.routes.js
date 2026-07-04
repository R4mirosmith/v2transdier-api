import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';

const router = Router();
router.use(authRequired);

router.get('/current', allowRoles('CASHIER','OPERATOR','ADMIN'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT cs.*, j.ferry_id, f.name AS ferry_name, c.business_name AS company_name
      FROM cash_sessions cs
      JOIN journeys j ON j.id = cs.journey_id
      JOIN ferries f ON f.id = j.ferry_id
      JOIN companies c ON c.id = j.company_id
      WHERE cs.user_id = ? AND cs.status = 'OPEN'
      ORDER BY cs.id DESC LIMIT 1
    `, [req.user.id]);
    res.json({ success: true, data: rows[0] || null });
  } catch (error) { next(error); }
});

router.post('/open', allowRoles('CASHIER','OPERATOR','ADMIN'), async (req, res, next) => {
  try {
    const { journey_id, opening_amount } = req.body;
    if (!journey_id) throw new AppError(400, 'VALIDATION_ERROR', 'Selecciona una jornada.');
    const result = await withTransaction(async (conn) => {
      const [current] = await conn.execute('SELECT id FROM cash_sessions WHERE user_id = ? AND status = \'OPEN\' FOR UPDATE', [req.user.id]);
      if (current.length) throw new AppError(409, 'CASH_ALREADY_OPEN', 'Ya tienes una caja abierta.');
      const [journeys] = await conn.execute('SELECT * FROM journeys WHERE id = ? AND status = \'OPEN\'', [journey_id]);
      const journey = journeys[0];
      if (!journey) throw new AppError(400, 'NO_OPEN_JOURNEY', 'La jornada seleccionada no está abierta.');
      const [insert] = await conn.execute(`
        INSERT INTO cash_sessions (user_id, company_id, ferry_id, journey_id, opening_amount)
        VALUES (?, ?, ?, ?, ?)
      `, [req.user.id, journey.company_id, journey.ferry_id, journey_id, Number(opening_amount || 0)]);
      const [rows] = await conn.execute('SELECT * FROM cash_sessions WHERE id = ?', [insert.insertId]);
      return rows[0];
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/close', allowRoles('CASHIER','OPERATOR','ADMIN'), async (req, res, next) => {
  try {
    const { counted_amount, notes } = req.body;
    if (counted_amount === undefined || counted_amount === null) throw new AppError(400, 'VALIDATION_ERROR', 'Ingresa el dinero contado.');
    const result = await withTransaction(async (conn) => {
      const [sessions] = await conn.execute('SELECT * FROM cash_sessions WHERE id = ? AND user_id = ? AND status = \'OPEN\' FOR UPDATE', [req.params.id, req.user.id]);
      const session = sessions[0];
      if (!session) throw new AppError(404, 'CASH_NOT_OPEN', 'La caja no existe o ya fue cerrada.');
      const [sumRows] = await conn.execute(`
        SELECT COALESCE(SUM(fare_price), 0) AS total
        FROM operations o
        WHERE o.cash_session_id = ?
          AND o.status IN ('PAID','BOARDED')
          AND o.payment_method = 'CASH'
          AND o.active_in_trip = 1
          AND EXISTS (SELECT 1 FROM trips t WHERE t.id = o.trip_id AND t.deleted_at_utc IS NULL)
      `, [session.id]);
      const expected = Number(session.opening_amount) + Number(sumRows[0].total || 0);
      const counted = Number(counted_amount || 0);
      const diff = counted - expected;
      await conn.execute(`
        UPDATE cash_sessions
        SET status = 'CLOSED', counted_amount = ?, expected_amount = ?, difference_amount = ?, closed_at_utc = UTC_TIMESTAMP(), notes = ?
        WHERE id = ?
      `, [counted, expected, diff, notes || null, session.id]);
      const [rows] = await conn.execute('SELECT * FROM cash_sessions WHERE id = ?', [session.id]);
      return rows[0];
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
