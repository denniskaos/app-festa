import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/roles.js';

const router = Router();

router.get('/seguranca/audit', requireAuth, requireRole('admin'), (_req, res) => {
  const rows = db.prepare(`
    SELECT id, dt, event, email, ip, meta
    FROM auth_audit
    ORDER BY id DESC
    LIMIT 200
  `).all();

  res.render('security_audit', {
    title: 'Auditoria de Segurança',
    rows,
  });
});

export default router;

