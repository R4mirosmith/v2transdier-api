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
        code: row.code,
        name: row.name,
        requires_load_status: !!row.requires_load_status,
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

router.get('/', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT vt.*, vf.load_status, vf.price, vf.active AS fare_active
      FROM vehicle_types vt
      LEFT JOIN vehicle_fares vf
        ON vf.vehicle_type_id = vt.id
       AND vf.active = 1
       AND ((vt.requires_load_status = 1 AND vf.load_status IN ('EMPTY','LOADED'))
         OR (vt.requires_load_status = 0 AND vf.load_status = 'NA'))
      ORDER BY vt.active DESC, vt.name ASC, vt.id ASC, vf.load_status ASC
    `);
    res.json({ success: true, data: mapTypes(rows) });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const name = text(req.body.name);
    const code = codeFrom(req.body.code || name);
    const requires = bool01(req.body.requires_load_status);
    const active = bool01(req.body.active ?? 1);

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre del tipo de vehículo es obligatorio.');
    if (!code) throw new AppError(400, 'VALIDATION_ERROR', 'El código del tipo de vehículo es obligatorio.');
    if (await codeExists(code)) throw new AppError(409, 'CODE_EXISTS', 'Ya existe un tipo de vehículo con ese código.');

    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO vehicle_types (code, name, requires_load_status, active)
       VALUES (?, ?, ?, ?)`,
      [code, name, requires, active]
    );
    const id = result.insertId;

    if (requires) {
      await upsertFare(connection, id, 'EMPTY', amount(req.body.price_empty, 'La tarifa descargado'));
      await upsertFare(connection, id, 'LOADED', amount(req.body.price_loaded, 'La tarifa cargado'));
    } else {
      await upsertFare(connection, id, 'NA', amount(req.body.price_na, 'La tarifa'));
    }

    await connection.commit();
    res.status(201).json({ success: true, message: 'Tipo de vehículo creado correctamente.', data: { id } });
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return next(new AppError(409, 'CODE_EXISTS', 'Ya existe un tipo de vehículo con ese código.'));
    next(error);
  } finally {
    connection.release();
  }
});

router.put('/:id', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const [current] = await connection.execute('SELECT * FROM vehicle_types WHERE id = ? LIMIT 1', [id]);
    if (!current.length) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');

    const name = text(req.body.name);
    const code = codeFrom(req.body.code || name);
    const requires = bool01(req.body.requires_load_status);
    const active = bool01(req.body.active ?? current[0].active);

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre del tipo de vehículo es obligatorio.');
    if (!code) throw new AppError(400, 'VALIDATION_ERROR', 'El código del tipo de vehículo es obligatorio.');
    if (await codeExists(code, id)) throw new AppError(409, 'CODE_EXISTS', 'Ya existe otro tipo de vehículo con ese código.');

    await connection.beginTransaction();
    await connection.execute(
      `UPDATE vehicle_types SET code = ?, name = ?, requires_load_status = ?, active = ? WHERE id = ?`,
      [code, name, requires, active, id]
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
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/:id/active', async (req, res, next) => {
  try {
    const active = bool01(req.body.active);
    const [result] = await pool.execute('UPDATE vehicle_types SET active = ? WHERE id = ?', [active, req.params.id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');
    res.json({ success: true, message: active ? 'Tipo de vehículo activado correctamente.' : 'Tipo de vehículo desactivado correctamente.' });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await pool.execute('UPDATE vehicle_types SET active = 0 WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Tipo de vehículo no encontrado.');
    res.json({ success: true, message: 'Tipo de vehículo desactivado correctamente.' });
  } catch (error) { next(error); }
});

export default router;
