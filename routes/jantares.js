// routes/jantares.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ---------- Migração defensiva: garantir coluna "title" ---------- */
(() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares')`).all().map(c => c.name);
    if (!cols.includes('title')) {
      db.exec(`ALTER TABLE jantares ADD COLUMN title TEXT`);
    }
  } catch {}
})();

/* ---------- Helpers ---------- */
// Receita do jantar = total efetivamente pago pelos presentes
function receitaPorJantarCents(j) {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    const hasPago  = cols.includes('pago_cents');
    const hasPres  = cols.includes('presenca');
    if (hasPago) {
      const sql = hasPres
        ? `SELECT IFNULL(SUM(pago_cents),0) AS s FROM jantares_convidados WHERE jantar_id=? AND presenca=1`
        : `SELECT IFNULL(SUM(pago_cents),0) AS s FROM jantares_convidados WHERE jantar_id=?`;
      return db.prepare(sql).get(j.id).s || 0;
    }
  } catch {}
  // fallback antigo (muito conservador)
  const pessoas = j.pessoas || 0;
  const base    = j.valor_pessoa_cents || 0;
  return pessoas * base;
}

/* ==================== LISTAR ==================== */
router.get('/jantares', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT
        id,
        COALESCE(dt,'')                    AS dt,
        COALESCE(title,'')                 AS title,
        COALESCE(pessoas,0)                AS pessoas,
        COALESCE(valor_pessoa_cents,0)     AS valor_pessoa_cents,
        COALESCE(despesas_cents,0)         AS despesas_cents,
        COALESCE(lancado,0)                AS lancado
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

    const jantares = rows.map(r => {
      const receita_cents = receitaPorJantarCents(r);
      const lucro_cents   = receita_cents - (r.despesas_cents || 0);
      return { ...r, receita_cents, lucro_cents };
    });

    const totalReceita  = jantares.reduce((a, r) => a + r.receita_cents, 0);
    const totalDespesas = jantares.reduce((a, r) => a + r.despesas_cents, 0);
    const totalLucro    = totalReceita - totalDespesas;

    res.render('jantares', {
      jantares,
      totalReceita,
      totalDespesas,
      totalLucro,
      euros,
      user: req.session.user
    });
  } catch (e) { next(e); }
});

/* ==================== NOVO ==================== */
router.get('/jantares/new', requireAuth, (_req, res) => {
  res.render('jantares_new');
});

/* ==================== CRIAR ==================== */
router.post('/jantares', requireAuth, (req, res, next) => {
  try {
    const { dt, title, pessoas, valor_pessoa, despesas } = req.body;
    db.prepare(`
      INSERT INTO jantares (dt, title, pessoas, valor_pessoa_cents, despesas_cents)
      VALUES (?,?,?,?,?)
    `).run(
      (dt || '').trim() || null,
      (title || '').trim() || null,
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas)
    );
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* ==================== EDITAR ==================== */
router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = db.prepare(`
      SELECT id,
             COALESCE(dt,'')                    AS dt,
             COALESCE(title,'')                 AS title,
             COALESCE(pessoas,0)                AS pessoas,
             COALESCE(valor_pessoa_cents,0)     AS valor_pessoa_cents,
             COALESCE(despesas_cents,0)         AS despesas_cents
      FROM jantares
      WHERE id=?
    `).get(req.params.id);

    if (!j) return res.status(404).send('Jantar não encontrado');
    res.render('jantares_edit', { j, euros, user: req.session.user });
  } catch (e) { next(e); }
});

/* ==================== ATUALIZAR ==================== */
router.post('/jantares/:id', requireAuth, (req, res, next) => {
  try {
    const { dt, title, pessoas, valor_pessoa, despesas } = req.body;
    db.prepare(`
      UPDATE jantares
         SET dt=?,
             title=?,
             pessoas=?,
             valor_pessoa_cents=?,
             despesas_cents=?
       WHERE id=?
    `).run(
      (dt || '').trim() || null,
      (title || '').trim() || null,
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas),
      req.params.id
    );
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* ==================== APAGAR ==================== */
router.post('/jantares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM jantares WHERE id=?`).run(req.params.id);
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

export default router;
