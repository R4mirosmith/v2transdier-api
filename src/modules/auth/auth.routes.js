import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../db/pool.js';
import { verifyPassword } from '../../utils/passwords.js';
import { env } from '../../config/env.js';
import { authRequired } from '../../middlewares/auth.js';
import { AppError } from '../../utils/errors.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError(400, 'VALIDATION_ERROR', 'Usuario y contraseña son obligatorios.');

    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
    const user = rows[0];
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    }

    const payload = { id: user.id, company_id: user.company_id, name: user.name, username: user.username, role: user.role };
    const token = jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    res.json({ success: true, token, user: payload });
  } catch (error) { next(error); }
});

router.get('/me', authRequired, (req, res) => {
  res.json({ success: true, user: req.user });
});

export default router;
