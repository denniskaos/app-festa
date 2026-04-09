// routes/peditorios.js
import { Router } from 'express';
import db, { cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// LISTAR
router.get('/peditorios', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      id, COALESCE(nome_pessoa,'') AS nome_pessoa, local, equipa,
      COALESCE(valor_prometido_cents, valor_cents, 0) AS valor_prometido_cents,
      COALESCE(valor_entregue_cents, valor_cents, 0) AS valor_entregue_cents
    FROM peditorios
    ORDER BY id DESC
  `).all();

  const total_valor_prometido_cents = rows.reduce((s, r) => s + (r.valor_prometido_cents || 0), 0);
  const total_valor_entregue_cents = rows.reduce((s, r) => s + (r.valor_entregue_cents || 0), 0);
  const total_valor_falta_cents = total_valor_prometido_cents - total_valor_entregue_cents;

  res.render('peditorios', {
    title: 'Peditórios',
    user: req.session.user,
    itens: rows,
    total_valor_prometido_cents,
    total_valor_entregue_cents,
    total_valor_falta_cents
  });
});

// NOVO (página)
router.get('/peditorios/new', requireAuth, (req, res) => {
  res.render('peditorios_new', {
    title: 'Novo Peditório',
    user: req.session.user
  });
});

// CRIAR
router.post('/peditorios', requireAuth, (req, res) => {
  const nome_pessoa = (req.body.nome_pessoa || '').trim() || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_prometido_cents = cents(req.body.valor_prometido || 0);
  const valor_entregue_cents = cents(req.body.valor_entregue || 0);

  db.prepare(`
    INSERT INTO peditorios (nome_pessoa, local, equipa, valor_cents, valor_prometido_cents, valor_entregue_cents)
    VALUES (?,?,?,?,?,?)
  `).run(nome_pessoa, local, equipa, valor_entregue_cents, valor_prometido_cents, valor_entregue_cents);

  res.redirect('/peditorios');
});

// EDITAR
router.post('/peditorios/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const nome_pessoa = (req.body.nome_pessoa || '').trim() || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_prometido_cents = cents(req.body.valor_prometido || 0);
  const valor_entregue_cents = cents(req.body.valor_entregue || 0);

  db.prepare(`
    UPDATE peditorios
       SET nome_pessoa=?, local=?, equipa=?, valor_cents=?, valor_prometido_cents=?, valor_entregue_cents=?
     WHERE id=?
  `).run(nome_pessoa, local, equipa, valor_entregue_cents, valor_prometido_cents, valor_entregue_cents, id);

  res.redirect('/peditorios');
});

// APAGAR
router.post('/peditorios/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM peditorios WHERE id=?').run(req.params.id);
  res.redirect('/peditorios');
});

export default router;
