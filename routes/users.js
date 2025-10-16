// routes/users.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/roles.js';

const router = Router();

/* LISTA (admin) */
router.get('/utilizadores', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role FROM users ORDER BY id').all();
  res.render('users', {
    title: 'Utilizadores',
    user: req.session.user,
    users,
    ROLES: ['admin','financeiro','viewer']
  });
});

/* CRIAR (admin) */
router.post('/utilizadores', requireAuth, requireRole('admin'), (req, res) => {
  const { name, email, role, password } = req.body;
  const hash = bcrypt.hashSync(password || '123456', 10);
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run((name||'').trim(), (email||'').trim().toLowerCase(), hash, role || 'viewer');
  res.redirect('/utilizadores');
});

/* MUDAR ROLE (admin) */
router.post('/utilizadores/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (req.session.user.id === id) return res.status(400).send('Não podes alterar o teu próprio role.');
  db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role || 'viewer', id);
  res.redirect('/utilizadores');
});

/* RESET PASSWORD (admin) */
router.post('/utilizadores/:id/reset', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const hash = bcrypt.hashSync((req.body.password || '123456'), 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
  res.redirect('/utilizadores');
});

/* APAGAR (admin) */
router.post('/utilizadores/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (req.session.user.id === id) return res.status(400).send('Não podes eliminar a tua conta.');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.redirect('/utilizadores');
});

export default router;

