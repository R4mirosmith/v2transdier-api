import { Router } from 'express';
import path from 'path';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { upload, setUploadFolder } from '../../middlewares/upload.js';
import { AppError } from '../../utils/errors.js';
import { fromColombiaDateRangeToUtc } from '../../utils/time.js';

const router = Router();
router.use(authRequired, allowRoles('ADMIN', 'SECRETARIA'));

function filePathForDb(file, folder) {
  if (!file) return null;
  return `/uploads/${folder}/${path.basename(file.path)}`;
}

router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = 'e.status = \'ACTIVE\'';
    if (req.query.ferry_id) { where += ' AND e.ferry_id = ?'; params.push(req.query.ferry_id); }
    if (req.query.journey_id) { where += ' AND e.journey_id = ?'; params.push(req.query.journey_id); }
    if (req.query.from) {
      const { startUtc, endUtc } = fromColombiaDateRangeToUtc(req.query.from, req.query.to || req.query.from);
      where += ' AND e.expense_at_utc BETWEEN ? AND ?'; params.push(startUtc, endUtc);
    }
    const [rows] = await pool.execute(`
      SELECT e.*, c.business_name AS company_name, f.name AS ferry_name, u.name AS created_by_name,
        j.status AS journey_status, j.opened_at_utc AS journey_opened_at_utc,
        t.status AS trip_status, t.opened_at_utc AS trip_opened_at_utc, t.closed_at_utc AS trip_closed_at_utc,
        r.name AS route_name
      FROM expenses e
      JOIN companies c ON c.id = e.company_id
      JOIN ferries f ON f.id = e.ferry_id
      JOIN users u ON u.id = e.created_by_user_id
      LEFT JOIN journeys j ON j.id = e.journey_id
      LEFT JOIN trips t ON t.id = e.trip_id
      LEFT JOIN routes r ON r.id = t.route_id
      WHERE ${where}
      ORDER BY e.expense_at_utc DESC, e.id DESC
      LIMIT 500
    `, params);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/', setUploadFolder('expenses'), upload.single('support_photo'), async (req, res, next) => {
  try {
    const ferryId = Number(req.body.ferry_id);
    const amount = Number(req.body.amount || 0);
    const description = String(req.body.description || '').trim();
    if (!ferryId || amount <= 0 || !description) throw new AppError(400, 'VALIDATION_ERROR', 'Ferry, valor y descripción son obligatorios.');
    const supportPath = filePathForDb(req.file, 'expenses');
    const result = await withTransaction(async (conn) => {
      const [ferries] = await conn.execute('SELECT * FROM ferries WHERE id = ? AND active = 1 AND deleted_at_utc IS NULL', [ferryId]);
      const ferry = ferries[0];
      if (!ferry) throw new AppError(400, 'INVALID_FERRY', 'Ferry inválido.');

      let journeyId = req.body.journey_id ? Number(req.body.journey_id) : null;
      let tripId = req.body.trip_id ? Number(req.body.trip_id) : null;

      if (journeyId) {
        const [journeys] = await conn.execute('SELECT id, ferry_id FROM journeys WHERE id = ? AND ferry_id = ?', [journeyId, ferryId]);
        if (!journeys[0]) throw new AppError(400, 'INVALID_JOURNEY', 'La jornada seleccionada no pertenece al ferry.');
      }

      if (tripId) {
        const [trips] = await conn.execute('SELECT id, journey_id, ferry_id FROM trips WHERE id = ? AND ferry_id = ? AND deleted_at_utc IS NULL', [tripId, ferryId]);
        const trip = trips[0];
        if (!trip) throw new AppError(400, 'INVALID_TRIP', 'El trayecto seleccionado no pertenece al ferry o está desactivado.');
        if (journeyId && Number(trip.journey_id) !== Number(journeyId)) {
          throw new AppError(400, 'TRIP_JOURNEY_MISMATCH', 'El trayecto seleccionado no pertenece a la jornada seleccionada.');
        }
        journeyId = journeyId || trip.journey_id;
      }

      const [insert] = await conn.execute(`
        INSERT INTO expenses (company_id, ferry_id, journey_id, trip_id, category, description, amount, support_photo_path, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [ferry.company_id, ferryId, journeyId, tripId, req.body.category || 'VARIOS', description, amount, supportPath, req.user.id]);
      const [rows] = await conn.execute('SELECT * FROM expenses WHERE id = ?', [insert.insertId]);
      return rows[0];
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/void', async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw new AppError(400, 'REASON_REQUIRED', 'El motivo es obligatorio.');
    await pool.execute(`
      UPDATE expenses SET status = 'VOID', void_reason = ?, voided_by_user_id = ?, voided_at_utc = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'ACTIVE'
    `, [reason, req.user.id, req.params.id]);
    res.json({ success: true, data: { id: Number(req.params.id), status: 'VOID' } });
  } catch (error) { next(error); }
});

export default router;
