import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { colombiaEndOfDayUtcForNow } from '../../utils/time.js';
import { validatePlate } from '../../utils/plates.js';
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


router.get('/:id/free-passes', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const journeyId = Number(req.params.id);
    if (!journeyId) throw new AppError(400, 'INVALID_JOURNEY', 'Jornada inválida.');
    const [rows] = await pool.execute(`
      SELECT p.*, u.name AS authorized_by_name, j.status AS journey_status, f.name AS ferry_name,
             GREATEST(p.allowed_uses - p.used_uses, 0) AS remaining_uses
      FROM journey_free_passes p
      JOIN journeys j ON j.id = p.journey_id
      JOIN ferries f ON f.id = j.ferry_id
      JOIN users u ON u.id = p.authorized_by_user_id
      WHERE p.journey_id = ?
      ORDER BY p.active DESC, p.id DESC
    `, [journeyId]);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/:id/free-passes', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const journeyId = Number(req.params.id);
    const allowedUses = Number(req.body.allowed_uses);
    const plateCheck = validatePlate(req.body.plate);
    if (!journeyId) throw new AppError(400, 'INVALID_JOURNEY', 'Jornada inválida.');
    if (!plateCheck.ok) throw new AppError(400, 'INVALID_PLATE', plateCheck.message);
    if (!Number.isInteger(allowedUses) || allowedUses < 1 || allowedUses > 100) {
      throw new AppError(400, 'INVALID_FREE_PASS_LIMIT', 'La cantidad de pases debe estar entre 1 y 100.');
    }

    let notification;
    const result = await withTransaction(async (conn) => {
      const [journeyRows] = await conn.execute(`
        SELECT j.*, f.name AS ferry_name
        FROM journeys j JOIN ferries f ON f.id = j.ferry_id
        WHERE j.id = ? FOR UPDATE
      `, [journeyId]);
      const journey = journeyRows[0];
      if (!journey) throw new AppError(404, 'JOURNEY_NOT_FOUND', 'Jornada no encontrada.');
      if (journey.status !== 'OPEN') throw new AppError(409, 'JOURNEY_CLOSED', 'Solo puedes autorizar pases en una jornada abierta.');

      const [existingRows] = await conn.execute(`
        SELECT * FROM journey_free_passes WHERE journey_id = ? AND normalized_plate = ? FOR UPDATE
      `, [journeyId, plateCheck.normalized]);
      const existing = existingRows[0];
      if (existing && allowedUses < Number(existing.used_uses)) {
        throw new AppError(409, 'FREE_PASS_LIMIT_BELOW_USED', `Esta placa ya usó ${existing.used_uses} pase(s). No puedes dejar el límite por debajo de lo consumido.`);
      }

      if (existing) {
        await conn.execute(`
          UPDATE journey_free_passes
          SET display_plate = ?, allowed_uses = ?, active = 1, authorized_by_user_id = ?, updated_at_utc = UTC_TIMESTAMP()
          WHERE id = ?
        `, [String(req.body.plate || '').trim().toUpperCase(), allowedUses, req.user.id, existing.id]);
      } else {
        await conn.execute(`
          INSERT INTO journey_free_passes (journey_id, normalized_plate, display_plate, allowed_uses, authorized_by_user_id)
          VALUES (?, ?, ?, ?, ?)
        `, [journeyId, plateCheck.normalized, String(req.body.plate || '').trim().toUpperCase(), allowedUses, req.user.id]);
      }

      const [rows] = await conn.execute(`
        SELECT p.*, u.name AS authorized_by_name, GREATEST(p.allowed_uses - p.used_uses, 0) AS remaining_uses
        FROM journey_free_passes p JOIN users u ON u.id = p.authorized_by_user_id
        WHERE p.journey_id = ? AND p.normalized_plate = ?
      `, [journeyId, plateCheck.normalized]);

      notification = await createNotification(conn, {
        type: 'journey:free_pass_authorized', severity: 'INFO', title: 'Pases gratis autorizados',
        message: `${req.user.name} autorizó ${allowedUses} pase(s) gratis para ${plateCheck.normalized} en la jornada #${journeyId}.`,
        payload: { journey_id: journeyId, plate: plateCheck.normalized, allowed_uses: allowedUses }
      });
      return rows[0];
    });
    publishNotification(notification);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.delete('/:id/free-passes/:passId', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const journeyId = Number(req.params.id);
    const passId = Number(req.params.passId);
    if (!journeyId || !passId) throw new AppError(400, 'INVALID_FREE_PASS', 'Autorización inválida.');
    const [result] = await pool.execute(`
      UPDATE journey_free_passes p
      JOIN journeys j ON j.id = p.journey_id
      SET p.active = 0, p.updated_at_utc = UTC_TIMESTAMP()
      WHERE p.id = ? AND p.journey_id = ? AND j.status = 'OPEN'
    `, [passId, journeyId]);
    if (!result.affectedRows) throw new AppError(404, 'FREE_PASS_NOT_ACTIVE', 'No se encontró un pase activo en una jornada abierta.');
    res.json({ success: true, data: { id: passId, active: 0 } });
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
