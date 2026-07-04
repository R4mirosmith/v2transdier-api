import { Router } from 'express';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';

const router = Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const onlyActive = req.query.all !== '1';
    const [rows] = await pool.execute(`
      SELECT f.*, c.business_name AS company_name
      FROM ferries f
      JOIN companies c ON c.id = f.company_id
      WHERE f.deleted_at_utc IS NULL ${onlyActive ? 'AND f.active = 1' : ''}
      ORDER BY c.business_name, f.name
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const companyId = Number(req.body.company_id);
    if (!companyId || !name) throw new AppError(400, 'VALIDATION_ERROR', 'Empresa y nombre del ferry son obligatorios.');
    const [insert] = await pool.execute(`
      INSERT INTO ferries (company_id, name, code, description, capacity_notes, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [companyId, name, req.body.code || null, req.body.description || null, req.body.capacity_notes || null, req.body.active === '0' ? 0 : 1]);
    const [rows] = await pool.execute('SELECT * FROM ferries WHERE id = ?', [insert.insertId]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
});

router.put('/:id', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM ferries WHERE id = ? AND deleted_at_utc IS NULL FOR UPDATE', [req.params.id]);
      const current = rows[0];
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Ferry no encontrado.');
      await conn.execute(`
        UPDATE ferries SET company_id = ?, name = ?, code = ?, description = ?, capacity_notes = ?, active = ?, updated_at_utc = UTC_TIMESTAMP()
        WHERE id = ?
      `, [req.body.company_id || current.company_id, req.body.name || current.name, req.body.code ?? current.code, req.body.description ?? current.description, req.body.capacity_notes ?? current.capacity_notes, req.body.active === '0' ? 0 : 1, req.params.id]);
      const [updated] = await conn.execute('SELECT * FROM ferries WHERE id = ?', [req.params.id]);
      return updated[0];
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.delete('/:id', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    await pool.execute('UPDATE ferries SET active = 0, deleted_at_utc = UTC_TIMESTAMP(), deleted_by_user_id = ?, updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [req.user.id, req.params.id]);
    res.json({ success: true, data: { id: Number(req.params.id), active: 0 } });
  } catch (error) { next(error); }
});

export default router;
