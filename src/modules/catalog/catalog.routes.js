import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired } from '../../middlewares/auth.js';

const router = Router();
router.use(authRequired);

router.get('/companies', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM companies WHERE active = 1 AND deleted_at_utc IS NULL ORDER BY business_name');
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/ferries', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT f.*, c.business_name AS company_name
      FROM ferries f
      JOIN companies c ON c.id = f.company_id
      WHERE f.active = 1 AND f.deleted_at_utc IS NULL
      ORDER BY c.business_name, f.name
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/routes', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT * FROM routes
      WHERE active = 1 AND name IN ('Magdalena -> Atlántico', 'Atlántico -> Magdalena')
      ORDER BY id
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/vehicle-types', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT vt.*, vf.load_status, vf.price
      FROM vehicle_types vt
      LEFT JOIN vehicle_fares vf
        ON vf.vehicle_type_id = vt.id
       AND vf.active = 1
       AND ((vt.requires_load_status = 1 AND vf.load_status IN ('EMPTY','LOADED'))
         OR (vt.requires_load_status = 0 AND vf.load_status = 'NA'))
      WHERE vt.active = 1
      ORDER BY vt.id, vf.load_status
    `);
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          code: row.code,
          name: row.name,
          requires_load_status: !!row.requires_load_status,
          registration_restricted: !!row.registration_restricted,
          fares: []
        });
      }
      if (row.load_status) map.get(row.id).fares.push({ load_status: row.load_status, price: row.price });
    }
    res.json({ success: true, data: Array.from(map.values()) });
  } catch (error) { next(error); }
});

export default router;
