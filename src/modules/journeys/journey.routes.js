import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { colombiaEndOfDayUtcForNow } from '../../utils/time.js';
import { createNotification, publishNotification } from '../notifications/notification.service.js';

const router = Router();
router.use(authRequired);

router.get('/', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT j.*, c.business_name AS company_name, f.name AS ferry_name, u.name AS opened_by_name, cu.name AS closed_by_name
      FROM journeys j
      JOIN companies c ON c.id = j.company_id
      JOIN ferries f ON f.id = j.ferry_id
      JOIN users u ON u.id = j.opened_by_user_id
      LEFT JOIN users cu ON cu.id = j.closed_by_user_id
      ORDER BY j.id DESC LIMIT 150
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/open', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT j.*, c.business_name AS company_name, f.name AS ferry_name
      FROM journeys j
      JOIN companies c ON c.id = j.company_id
      JOIN ferries f ON f.id = j.ferry_id
      WHERE j.status = 'OPEN'
      ORDER BY j.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/open', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const { ferry_id, notes } = req.body;
    if (!ferry_id) throw new AppError(400, 'VALIDATION_ERROR', 'Debes seleccionar un ferry.');

    let notification;
    const result = await withTransaction(async (conn) => {
      const [ferries] = await conn.execute('SELECT * FROM ferries WHERE id = ? AND active = 1 AND deleted_at_utc IS NULL', [ferry_id]);
      const ferry = ferries[0];
      if (!ferry) throw new AppError(400, 'INVALID_FERRY', 'Ferry inválido o inactivo.');
      const [open] = await conn.execute('SELECT id FROM journeys WHERE ferry_id = ? AND status = \'OPEN\' FOR UPDATE', [ferry_id]);
      if (open.length) throw new AppError(409, 'JOURNEY_ALREADY_OPEN', 'Ya existe una jornada abierta para este ferry.');
      const scheduledClose = colombiaEndOfDayUtcForNow();
      const [insert] = await conn.execute(`
        INSERT INTO journeys (company_id, ferry_id, opened_by_user_id, scheduled_close_at_utc, notes)
        VALUES (?, ?, ?, ?, ?)
      `, [ferry.company_id, ferry_id, req.user.id, scheduledClose, notes || null]);
      const [rows] = await conn.execute(`
        SELECT j.*, f.name AS ferry_name, c.business_name AS company_name
        FROM journeys j
        JOIN ferries f ON f.id = j.ferry_id
        JOIN companies c ON c.id = j.company_id
        WHERE j.id = ?
      `, [insert.insertId]);
      notification = await createNotification(conn, {
        type: 'journey:opened', severity: 'INFO', title: 'Jornada abierta',
        message: `${req.user.name} abrió la jornada de ${rows[0].ferry_name}. Cierre programado 11:59 p. m. Colombia.`, payload: { journey_id: insert.insertId, scheduled_close_at_utc: scheduledClose }
      });
      return rows[0];
    });
    publishNotification(notification);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/close', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    let notification;
    const result = await withTransaction(async (conn) => {
      await conn.execute(`UPDATE trips SET status = 'CLOSED', closed_by_user_id = ?, closed_at_utc = UTC_TIMESTAMP() WHERE journey_id = ? AND status = 'OPEN'`, [req.user.id, req.params.id]);
      const [update] = await conn.execute(`
        UPDATE journeys SET status = 'CLOSED', closed_by_user_id = ?, closed_at_utc = UTC_TIMESTAMP()
        WHERE id = ? AND status = 'OPEN'
      `, [req.user.id, req.params.id]);
      if (!update.affectedRows) throw new AppError(404, 'JOURNEY_NOT_OPEN', 'La jornada no existe o ya está cerrada.');
      notification = await createNotification(conn, {
        type: 'journey:closed', severity: 'INFO', title: 'Jornada cerrada',
        message: `${req.user.name} cerró una jornada.`, payload: { journey_id: Number(req.params.id) }
      });
      return { id: Number(req.params.id), status: 'CLOSED' };
    });
    publishNotification(notification);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
