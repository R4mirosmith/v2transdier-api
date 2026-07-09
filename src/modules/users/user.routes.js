import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';
import { hashPassword } from '../../utils/passwords.js';

const router = Router();
router.use(authRequired, allowRoles('ADMIN'));

const VALID_ROLES = new Set(['ADMIN', 'CASHIER', 'OPERATOR', 'SOCIO', 'SECRETARIA']);

function cleanText(value) {
  return String(value || '').trim();
}

function cleanUsername(value) {
  return cleanText(value).toLowerCase();
}

function normalizeActive(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

async function usernameExists(username, excludeId = null) {
  const params = excludeId ? [username, excludeId] : [username];
  const sql = excludeId ? 'SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1' : 'SELECT id FROM users WHERE username = ? LIMIT 1';
  const [rows] = await pool.execute(sql, params);
  return rows.length > 0;
}

router.get('/', async (req, res, next) => {
  try {
    const includeInactive = req.query.all === '1' || req.query.includeInactive === '1';
    const [rows] = await pool.execute(`
      SELECT u.id, u.company_id, c.business_name AS company_name, u.name, u.username, u.role, u.active, u.created_at_utc
      FROM users u
      LEFT JOIN companies c ON c.id = u.company_id
      ${includeInactive ? '' : 'WHERE u.active = 1'}
      ORDER BY u.active DESC, u.name ASC, u.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const companyId = req.body.company_id || null;
    const name = cleanText(req.body.name);
    const username = cleanUsername(req.body.username);
    const role = cleanText(req.body.role).toUpperCase();
    const password = String(req.body.password || '');
    const active = normalizeActive(req.body.active ?? 1);

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre del usuario es obligatorio.');
    if (!username) throw new AppError(400, 'VALIDATION_ERROR', 'El usuario de acceso es obligatorio.');
    if (!VALID_ROLES.has(role)) throw new AppError(400, 'VALIDATION_ERROR', 'Rol inválido. Usa ADMIN, CASHIER, OPERATOR, SOCIO o SECRETARIA.');
    if (password.length < 6) throw new AppError(400, 'VALIDATION_ERROR', 'La contraseña debe tener mínimo 6 caracteres.');
    if (await usernameExists(username)) throw new AppError(409, 'USERNAME_EXISTS', 'Ya existe un usuario con ese nombre de acceso.');

    const [result] = await pool.execute(
      `INSERT INTO users (company_id, name, username, password_hash, role, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId || null, name, username, hashPassword(password), role, active]
    );

    res.status(201).json({ success: true, message: 'Usuario creado correctamente.', data: { id: result.insertId } });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return next(new AppError(409, 'USERNAME_EXISTS', 'Ya existe un usuario con ese nombre de acceso.'));
    if ((error?.code === 'WARN_DATA_TRUNCATED' || error?.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') && String(error?.message || '').includes('role')) {
      return next(new AppError(400, 'ROLE_ENUM_NEEDS_MIGRATION', 'La base de datos aún no permite este rol. Ejecuta la migración de roles para habilitar SECRETARIA.'));
    }
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const [currentRows] = await pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (!currentRows.length) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');

    const name = cleanText(req.body.name);
    const username = cleanUsername(req.body.username);
    const role = cleanText(req.body.role).toUpperCase();
    const companyId = req.body.company_id || null;
    const active = normalizeActive(req.body.active ?? currentRows[0].active);
    const password = String(req.body.password || '');

    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre del usuario es obligatorio.');
    if (!username) throw new AppError(400, 'VALIDATION_ERROR', 'El usuario de acceso es obligatorio.');
    if (!VALID_ROLES.has(role)) throw new AppError(400, 'VALIDATION_ERROR', 'Rol inválido. Usa ADMIN, CASHIER, OPERATOR, SOCIO o SECRETARIA.');
    if (password && password.length < 6) throw new AppError(400, 'VALIDATION_ERROR', 'La nueva contraseña debe tener mínimo 6 caracteres.');
    if (await usernameExists(username, id)) throw new AppError(409, 'USERNAME_EXISTS', 'Ya existe otro usuario con ese nombre de acceso.');
    if (String(req.user.id) === String(id) && active === 0) throw new AppError(400, 'VALIDATION_ERROR', 'No puedes desactivar tu propio usuario.');

    if (password) {
      await pool.execute(
        `UPDATE users SET company_id = ?, name = ?, username = ?, password_hash = ?, role = ?, active = ? WHERE id = ?`,
        [companyId || null, name, username, hashPassword(password), role, active, id]
      );
    } else {
      await pool.execute(
        `UPDATE users SET company_id = ?, name = ?, username = ?, role = ?, active = ? WHERE id = ?`,
        [companyId || null, name, username, role, active, id]
      );
    }

    res.json({ success: true, message: 'Usuario actualizado correctamente.' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return next(new AppError(409, 'USERNAME_EXISTS', 'Ya existe otro usuario con ese nombre de acceso.'));
    if ((error?.code === 'WARN_DATA_TRUNCATED' || error?.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') && String(error?.message || '').includes('role')) {
      return next(new AppError(400, 'ROLE_ENUM_NEEDS_MIGRATION', 'La base de datos aún no permite este rol. Ejecuta la migración de roles para habilitar SECRETARIA.'));
    }
    next(error);
  }
});

router.patch('/:id/active', async (req, res, next) => {
  try {
    const { id } = req.params;
    const active = normalizeActive(req.body.active);
    if (String(req.user.id) === String(id) && active === 0) throw new AppError(400, 'VALIDATION_ERROR', 'No puedes desactivar tu propio usuario.');
    const [result] = await pool.execute('UPDATE users SET active = ? WHERE id = ?', [active, id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');
    res.json({ success: true, message: active ? 'Usuario activado correctamente.' : 'Usuario desactivado correctamente.' });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (String(req.user.id) === String(id)) throw new AppError(400, 'VALIDATION_ERROR', 'No puedes desactivar tu propio usuario.');
    const [result] = await pool.execute('UPDATE users SET active = 0 WHERE id = ?', [id]);
    if (!result.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado.');
    res.json({ success: true, message: 'Usuario desactivado correctamente.' });
  } catch (error) { next(error); }
});

export default router;
