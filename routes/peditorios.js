// routes/peditorios.js
import { Router } from 'express';
import db, { cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// LISTAR
router.get('/peditorios', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, dt, local, equipa, valor_cents, notas
    FROM peditorios
    ORDER BY (dt IS NULL), dt, id
  `).all();

  const total_valor_cents = rows.reduce((s, r) => s + (r.valor_cents || 0), 0);

  res.render('peditorios', {
    title: 'Peditórios',
    user: req.session.user,
    itens: rows,
    total_valor_cents
  });
});

// CRIAR
router.post('/peditorios', requireAuth, (req, res) => {
  const dt = (req.body.dt || null) || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_cents = cents(req.body.valor || 0);
  const notas = (req.body.notas || '').trim() || null;

  db.prepare(`
    INSERT INTO peditorios (dt, local, equipa, valor_cents, notas)
    VALUES (?,?,?,?,?)
  `).run(dt, local, equipa, valor_cents, notas);

  res.redirect('/peditorios');
});

// EDITAR
router.post('/peditorios/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const dt = (req.body.dt || null) || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_cents = cents(req.body.valor || 0);
  const notas = (req.body.notas || '').trim() || null;

  db.prepare(`
    UPDATE peditorios
       SET dt=?, local=?, equipa=?, valor_cents=?, notas=?
     WHERE id=?
  `).run(dt, local, equipa, valor_cents, notas, id);

  res.redirect('/peditorios');
});

// APAGAR
router.post('/peditorios/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM peditorios WHERE id=?').run(req.params.id);
  res.redirect('/peditorios');
});

export default router;
