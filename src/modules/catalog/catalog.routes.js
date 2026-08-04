import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';

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
      SELECT
        vt.*,
        vc.code AS vehicle_category_code,
        vc.name AS vehicle_category_name,
        vc.plate_category,
        vc.image_path AS vehicle_category_image_path,
        vf.load_status,
        vf.price
      FROM vehicle_types vt
      JOIN vehicle_categories vc ON vc.id = vt.vehicle_category_id
      LEFT JOIN vehicle_fares vf
        ON vf.vehicle_type_id = vt.id
       AND vf.active = 1
       AND ((vt.requires_load_status = 1 AND vf.load_status IN ('EMPTY','LOADED'))
         OR (vt.requires_load_status = 0 AND vf.load_status = 'NA'))
      WHERE vt.active = 1
        AND vt.category_review_required = 0
        AND vc.active = 1
      ORDER BY vc.sort_order, vt.name, vt.id, vf.load_status
    `);
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          vehicle_category_id: row.vehicle_category_id,
          vehicle_category_code: row.vehicle_category_code,
          vehicle_category_name: row.vehicle_category_name,
          plate_category: row.plate_category,
          vehicle_category_image_path: row.vehicle_category_image_path || null,
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
  } catch (error) {
    if (error?.code === 'ER_BAD_FIELD_ERROR' && String(error.message || '').includes('image_path')) {
      return next(new AppError(
        400,
        'VEHICLE_CATEGORY_IMAGES_NEED_MIGRATION',
        'Falta habilitar imágenes para las categorías. Ejecuta database/migration_imagenes_categorias_vehiculos.sql.'
      ));
    }
    next(error);
  }
});

export default router;
