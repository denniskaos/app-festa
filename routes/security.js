import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/roles.js';

const router = Router();

router.get('/seguranca/audit', requireAuth, requireRole('admin'), (_req, res) => {
  const event = String(_req.query.event || '').trim();
  const q = String(_req.query.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1000, Number(_req.query.limit || 200)));
  const where = [];
  const params = {};
  if (event) {
    where.push('event = @event');
    params.event = event;
  }
  if (q) {
    where.push('(LOWER(email) LIKE @q OR LOWER(ip) LIKE @q OR LOWER(COALESCE(meta, \'\')) LIKE @q)');
    params.q = `%${q}%`;
  }
  params.limit = limit;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT id, dt, event, email, ip, meta
    FROM auth_audit
    ${whereSql}
    ORDER BY id DESC
    LIMIT @limit
  `).all(params);

  res.render('security_audit', {
    title: 'Auditoria de Segurança',
    rows,
    filters: { event, q, limit },
  });
});

router.get('/seguranca/audit.csv', requireAuth, requireRole('admin'), (_req, res) => {
  const limit = Math.max(1, Math.min(5000, Number(_req.query.limit || 1000)));
  const rows = db.prepare(`
    SELECT id, dt, event, email, ip, meta
    FROM auth_audit
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['id', 'dt', 'event', 'email', 'ip', 'meta'].join(','),
    ...rows.map(r => [r.id, r.dt, r.event, r.email, r.ip, r.meta].map(esc).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="auth_audit.csv"');
  res.send(csv);
});

export default router;
