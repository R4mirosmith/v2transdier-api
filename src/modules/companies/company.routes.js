import { Router } from 'express';
import path from 'path';
import { pool, withTransaction } from '../../db/pool.js';
import { authRequired, allowRoles } from '../../middlewares/auth.js';
import { upload, setUploadFolder } from '../../middlewares/upload.js';
import { AppError } from '../../utils/errors.js';

const router = Router();
router.use(authRequired);

function filePathForDb(file, folder) {
  if (!file) return null;
  return `/uploads/${folder}/${path.basename(file.path)}`;
}

router.get('/', allowRoles('ADMIN'), async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT c.*, COUNT(f.id) AS ferries_count
      FROM companies c
      LEFT JOIN ferries f ON f.company_id = c.id AND f.deleted_at_utc IS NULL
      WHERE c.deleted_at_utc IS NULL
      GROUP BY c.id
      ORDER BY c.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.get('/active', async (_req, res, next) => {
  try {
    const [rows] = await pool.execute(`SELECT * FROM companies WHERE active = 1 AND deleted_at_utc IS NULL ORDER BY business_name`);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

router.post('/', allowRoles('ADMIN'), setUploadFolder('companies'), upload.single('logo'), async (req, res, next) => {
  try {
    const businessName = String(req.body.business_name || '').trim();
    if (!businessName) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre de la empresa es obligatorio.');
    const logoPath = filePathForDb(req.file, 'companies');
    const [insert] = await pool.execute(`
      INSERT INTO companies (business_name, trade_name, nit, logo_path, address, phone, electronic_billing_phone_1, electronic_billing_phone_2, email, legal_representative, ticket_footer, active, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [businessName, req.body.trade_name || null, req.body.nit || null, logoPath, req.body.address || null, req.body.phone || null, req.body.electronic_billing_phone_1 || null, req.body.electronic_billing_phone_2 || null, req.body.email || null, req.body.legal_representative || null, req.body.ticket_footer || null, req.body.active === '0' ? 0 : 1, req.user.id]);
    const [rows] = await pool.execute('SELECT * FROM companies WHERE id = ?', [insert.insertId]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (error) { next(error); }
});

router.put('/:id', allowRoles('ADMIN'), setUploadFolder('companies'), upload.single('logo'), async (req, res, next) => {
  try {
    const logoPath = filePathForDb(req.file, 'companies');
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM companies WHERE id = ? AND deleted_at_utc IS NULL FOR UPDATE', [req.params.id]);
      const current = rows[0];
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Empresa no encontrada.');
      const businessName = String(req.body.business_name || current.business_name || '').trim();
      if (!businessName) throw new AppError(400, 'VALIDATION_ERROR', 'El nombre de la empresa es obligatorio.');
      await conn.execute(`
        UPDATE companies SET business_name = ?, trade_name = ?, nit = ?, logo_path = COALESCE(?, logo_path), address = ?, phone = ?, electronic_billing_phone_1 = ?, electronic_billing_phone_2 = ?, email = ?, legal_representative = ?, ticket_footer = ?, active = ?, updated_at_utc = UTC_TIMESTAMP()
        WHERE id = ?
      `, [businessName, req.body.trade_name ?? current.trade_name, req.body.nit ?? current.nit, logoPath, req.body.address ?? current.address, req.body.phone ?? current.phone, req.body.electronic_billing_phone_1 ?? current.electronic_billing_phone_1, req.body.electronic_billing_phone_2 ?? current.electronic_billing_phone_2, req.body.email ?? current.email, req.body.legal_representative ?? current.legal_representative, req.body.ticket_footer ?? current.ticket_footer, req.body.active === '0' ? 0 : 1, req.params.id]);
      const [updated] = await conn.execute('SELECT * FROM companies WHERE id = ?', [req.params.id]);
      return updated[0];
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.delete('/:id', allowRoles('ADMIN'), async (req, res, next) => {
  try {
    await pool.execute('UPDATE companies SET active = 0, deleted_at_utc = UTC_TIMESTAMP(), updated_at_utc = UTC_TIMESTAMP() WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { id: Number(req.params.id), active: 0 } });
  } catch (error) { next(error); }
});

export default router;
