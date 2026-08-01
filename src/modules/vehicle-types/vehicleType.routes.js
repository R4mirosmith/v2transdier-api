import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';

const router = Router();
router.use(authRequired, allowRoles('ADMIN'));

function text(value) {
  return String(value || '').trim();
}

function codeFrom(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function bool01(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function migrationErrorIfNeeded(error) {
  const message = String(error?.message || '');
  if (
    error?.code === 'ER_NO_SUCH_TABLE' && message.includes('vehicle_categories')
    || error?.code === 'ER_BAD_FIELD_ERROR' && (
      message.includes('vehicle_category_id')
      || message.includes('category_review_required')
    )
  ) {
    return new AppError(
      400,
      'VEHICLE_CATEGORIES_NEED_MIGRATION',
      'La base de datos aún no tiene las categorías reales de vehículos. Ejecuta database/migration_categorias_reales_vehiculos.sql.'
    );
  }
  if (error?.code === 'ER_BAD_FIELD_ERROR' && message.includes('registration_restricted')) {
    return new AppError(400, 'VEHICLE_TYPE_RESTRICTION_NEEDS_MIGRATION', 'La base de datos aún no tiene la columna de restricción. Ejecuta database/migration_restriccion_tipos_vehiculo_secretaria.sql.');
  }
  return null;
}

function amount(value, label) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'VALIDATION_ERROR', `${label} debe ser un valor válido mayor o igual a 0.`);
  return n;
}

async function codeExists(code, excludeId = null) {
  const [rows] = await pool.execute(
    excludeId ? 'SELECT id FROM vehicle_types WHERE code = ? AND id <> ? LIMIT 1' : 'SELECT id FROM vehicle_types WHERE code = ? LIMIT 1',
    excludeId ? [code, excludeId] : [code]
  );
  return rows.length > 0;
}

async function getCategory(connection, categoryId) {
  const [rows] = await connection.execute(
    `SELECT id, code, name, plate_category, active
     FROM vehicle_categories
     WHERE id = ?
     LIMIT 1`,
    [categoryId]
  );
  const category = rows[0];
  if (!category || Number(category.active) !== 1) {
    throw new AppError(400, 'INVALID_VEHICLE_CATEGORY', 'Selecciona una categoría real de vehículo válida y activa.');
  }
  return category;
}

async function upsertFare(connection, vehicleTypeId, loadStatus, price) {
  await connection.execute(
    `INSERT INTO vehicle_fares (vehicle_type_id, load_status, price, active)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE price = VALUES(price), active = 1, updated_at_utc = CURRENT_TIMESTAMP`,
    [vehicleTypeId, loadStatus, price]
  );
}

function mapTypes(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        vehicle_category_id: row.vehicle_category_id,
        vehicle_category_code: row.vehicle_category_code,
        vehicle_category_name: row.vehicle_category_name,
        plate_category: row.plate_category,
        code: row.code,
        name: row.name,
        requires_load_status: !!row.requires_load_status,
        registration_restricted: !!row.registration_restricted,
        category_review_required: !!row.category_review_required,
        active: !!row.active,
        created_at_utc: row.created_at_utc,
        fares: [],
        price_na: '',
        price_empty: '',
        price_loaded: ''
      });
    }
    const item = map.get(row.id);
    if (row.load_status) {
      item.fares.push({ load_status: row.load_status, price: Number(row.price || 0), active: !!row.fare_active });
      if (row.load_status === 'NA') item.price_na = Number(row.price || 0);
      if (row.load_status === 'EMPTY') item.price_empty = Number(row.price || 0);
      if (row.load_status === 'LOADED') item.price_loaded = Number(row.price || 0);
    }
  }
  return Array.from(map.values());
}

router.get('/categories', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT id, code, name, plate_category, active, sort_order
      FROM vehicle_categories
      WHERE active = 1
      ORDER BY sort_order, name
    `);
    res.json({ success: true, data: rows.map((row) => ({ ...row, active: !!row.active })) });
  } catch (error) {
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    next(error);
  }
});

router.get('/', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        vt.*,
        vc.code AS vehicle_category_code,
        vc.name AS vehicle_category_name,
        vc.plate_category,
        vf.load_status,
        vf.price,
        vf.active AS fare_active
      FROM vehicle_types vt
      JOIN vehicle_categories vc ON vc.id = vt.vehicle_category_id
      LEFT JOIN vehicle_fares vf
        ON vf.vehicle_type_id = vt.id
       AND vf.active = 1
       AND ((vt.requires_load_status = 1 AND vf.load_status IN ('EMPTY','LOADED'))
         OR (vt.requires_load_status = 0 AND vf.load_status = 'NA'))
      ORDER BY vt.category_review_required DESC, vt.active DESC, vc.sort_order, vt.name, vt.id, vf.load_status
    `);
    res.json({ success: true, data: mapTypes(rows) });
  } catch (error) {
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const name = text(req.body.name);
    const code = codeFrom(req.body.code || name);
    const categoryId = Number(req.body.vehicle_category_id);
    const requires = bool01(req.body.requires_load_status);
    const restricted = bool01(req.body.registration_restricted ?? req.body.restricted ?? 0);
    const active = bool01(req.body.active ?? 1);

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre comercial del tipo de vehículo es obligatorio.');
    if (!code) throw new AppError(400, 'VALIDATION_ERROR', 'El código del tipo de vehículo es obligatorio.');
    if (!Number.isInteger(categoryId) || categoryId <= 0) throw new AppError(400, 'INVALID_VEHICLE_CATEGORY', 'La categoría real del vehículo es obligatoria.');
    if (await codeExists(code)) throw new AppError(409, 'CODE_EXISTS', 'Ya existe un tipo de vehículo con ese código.');

    await connection.beginTransaction();
    await getCategory(connection, categoryId);

    const [result] = await connection.execute(
      `INSERT INTO vehicle_types (
        vehicle_category_id, code, name, requires_load_status,
        registration_restricted, category_review_required, active
      ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [categoryId, code, name, requires, restricted, active]
    );
    const id = result.insertId;

    if (requires) {
      await upsertFare(connection, id, 'EMPTY', amount(req.body.price_empty, 'La tarifa descargado'));
      await upsertFare(connection, id, 'LOADED', amount(req.body.price_loaded, 'La tarifa cargado'));
    } else {
      await upsertFare(connection, id, 'NA', amount(req.body.price_na, 'La tarifa'));
    }

    await connection.commit();
    res.status(201).json({ success: true, message: 'Tipo comercial creado y asociado a su categoría real.', data: { id } });
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return next(new AppError(409, 'CODE_EXISTS', 'Ya existe un tipo de vehículo con ese código.'));
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    next(error);
  } finally {
    connection.release();
  }
});

router.put('/:id', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const [currentRows] = await connection.execute('SELECT * FROM vehicle_types WHERE id = ? LIMIT 1', [id]);
    const current = currentRows[0];
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');

    const name = text(req.body.name);
    const code = codeFrom(req.body.code || name);
    const categoryId = Number(req.body.vehicle_category_id);
    const requires = bool01(req.body.requires_load_status);
    const restricted = bool01(req.body.registration_restricted ?? req.body.restricted ?? current.registration_restricted);
    const active = bool01(req.body.active ?? current.active);

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre comercial del tipo de vehículo es obligatorio.');
    if (!code) throw new AppError(400, 'VALIDATION_ERROR', 'El código del tipo de vehículo es obligatorio.');
    if (!Number.isInteger(categoryId) || categoryId <= 0) throw new AppError(400, 'INVALID_VEHICLE_CATEGORY', 'La categoría real del vehículo es obligatoria.');
    if (await codeExists(code, id)) throw new AppError(409, 'CODE_EXISTS', 'Ya existe otro tipo de vehículo con ese código.');

    await connection.beginTransaction();
    await getCategory(connection, categoryId);

    if (Number(current.vehicle_category_id) !== categoryId) {
      const [[usage]] = await connection.query(`
        SELECT
          (SELECT COUNT(*) FROM vehicles WHERE vehicle_type_id = ?) AS vehicles_count,
          (SELECT COUNT(*) FROM operations WHERE vehicle_type_id = ?) AS operations_count,
          (SELECT COUNT(*) FROM restricted_vehicle_registration_requests WHERE vehicle_type_id = ?) AS requests_count
      `, [id, id, id]);
      if (Number(usage.vehicles_count) > 0 || Number(usage.operations_count) > 0 || Number(usage.requests_count) > 0) {
        throw new AppError(
          409,
          'VEHICLE_TYPE_CATEGORY_LOCKED',
          'Esta opción ya fue utilizada. Para proteger el historial, crea una nueva opción con la categoría correcta y desactiva la anterior.'
        );
      }
    }

    await connection.execute(
      `UPDATE vehicle_types
       SET vehicle_category_id = ?, code = ?, name = ?, requires_load_status = ?,
           registration_restricted = ?, category_review_required = 0, active = ?
       WHERE id = ?`,
      [categoryId, code, name, requires, restricted, active, id]
    );

    if (requires) {
      await upsertFare(connection, id, 'EMPTY', amount(req.body.price_empty, 'La tarifa descargado'));
      await upsertFare(connection, id, 'LOADED', amount(req.body.price_loaded, 'La tarifa cargado'));
    } else {
      await upsertFare(connection, id, 'NA', amount(req.body.price_na, 'La tarifa'));
    }

    await connection.commit();
    res.json({ success: true, message: 'Tipo de vehículo actualizado correctamente.' });
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return next(new AppError(409, 'CODE_EXISTS', 'Ya existe otro tipo de vehículo con ese código.'));
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/:id/active', async (req, res, next) => {
  try {
    const active = bool01(req.body.active);
    if (active) {
      const [rows] = await pool.execute(`
        SELECT vt.id, vt.category_review_required, vc.active AS category_active
        FROM vehicle_types vt
        JOIN vehicle_categories vc ON vc.id = vt.vehicle_category_id
        WHERE vt.id = ?
        LIMIT 1
      `, [req.params.id]);
      const item = rows[0];
      if (!item) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');
      if (Number(item.category_review_required) === 1 || Number(item.category_active) !== 1) {
        throw new AppError(409, 'CATEGORY_REVIEW_REQUIRED', 'Primero edita esta opción y asígnale una categoría real antes de activarla.');
      }
    }
    const [result] = await pool.execute('UPDATE vehicle_types SET active = ? WHERE id = ?', [active, req.params.id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');
    res.json({ success: true, message: active ? 'Tipo de vehículo activado correctamente.' : 'Tipo de vehículo desactivado correctamente.' });
  } catch (error) {
    const migrationError = migrationErrorIfNeeded(error);
    if (migrationError) return next(migrationError);
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.execute('UPDATE vehicle_types SET active = 0 WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');
    res.json({ success: true, message: 'Tipo de vehículo desactivado correctamente.' });
  } catch (error) { next(error); }
});

export default router;
