// routes/jantares.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* LISTAR */
router.get('/jantares', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT
        id,
        COALESCE(dt, '')                       AS dt,
        COALESCE(pessoas, 0)                   AS pessoas,
        COALESCE(valor_pessoa_cents, 0)        AS valor_pessoa_cents,
        COALESCE(despesas_cents, 0)            AS despesas_cents
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

    const withCalc = rows.map(r => {
      const receita_cents = (r.pessoas || 0) * (r.valor_pessoa_cents || 0);
      const lucro_cents   = receita_cents - (r.despesas_cents || 0);
      return { ...r, receita_cents, lucro_cents };
    });

    const totalReceita  = withCalc.reduce((a, r) => a + r.receita_cents, 0);
    const totalDespesas = withCalc.reduce((a, r) => a + r.despesas_cents, 0);
    const totalLucro    = totalReceita - totalDespesas;

    // ajusta os nomes se a tua view esperar outros
    res.render('jantares', {
      jantares: withCalc,
      totalReceita,
      totalDespesas,
      totalLucro,
      euros,
      user: req.session.user
    });
  } catch (e) { next(e); }
});

/* FORM NOVO */
router.get('/jantares/new', requireAuth, (_req, res) => {
  res.render('jantares_new');
});

/* CRIAR */
router.post('/jantares', requireAuth, (req, res, next) => {
  try {
    const { dt, pessoas, valor_pessoa, despesas } = req.body;
    db.prepare(`
      INSERT INTO jantares (dt, pessoas, valor_pessoa_cents, despesas_cents)
      VALUES (?,?,?,?)
    `).run(
      dt || null,
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas)
    );
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* EDITAR */
router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = db.prepare(`
      SELECT id,
             COALESCE(dt,'') as dt,
             COALESCE(pessoas,0) as pessoas,
             COALESCE(valor_pessoa_cents,0) as valor_pessoa_cents,
             COALESCE(despesas_cents,0) as despesas_cents
      FROM jantares WHERE id=?
    `).get(req.params.id);
    if (!j) return res.status(404).send('Jantar não encontrado');
    res.render('jantares_edit', { j, euros, user: req.session.user });
  } catch (e) { next(e); }
});

/* ATUALIZAR */
router.post('/jantares/:id', requireAuth, (req, res, next) => {
  try {
    const { dt, pessoas, valor_pessoa, despesas } = req.body;
    db.prepare(`
      UPDATE jantares
         SET dt=?,
             pessoas=?,
             valor_pessoa_cents=?,
             despesas_cents=?
       WHERE id=?
    `).run(
      dt || null,
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas),
      req.params.id
    );
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* APAGAR */
router.post('/jantares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM jantares WHERE id=?`).run(req.params.id);
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

export default router;
