import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';

const router = Router();
router.use(authRequired);

router.get('/', allowRoles('ADMIN'), async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT * FROM notifications
      WHERE user_id IS NULL
      ORDER BY id DESC LIMIT 100
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/:id/read', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    await pool.execute('UPDATE notifications SET read_at_utc = UTC_TIMESTAMP() WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) { next(error); }
});

export default router;
