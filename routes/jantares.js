// routes/jantares.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* -------------------- migrações defensivas -------------------- */
// garante coluna title em jantares
(() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares')`).all().map(c => c.name);
    if (!cols.includes('title')) {
      db.exec(`ALTER TABLE jantares ADD COLUMN title TEXT`);
    }
  } catch (e) { /* ignore */ }
})();

// saber se a coluna preco_cents existe em jantares_convidados (para o cálculo de receita)
const HAS_PRECO_COL = (() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    return cols.includes('preco_cents');
  } catch (e) { return false; }
})();

/* -------------------- helpers -------------------- */
function receitaPorJantarCents(j) {
  const base = j.valor_pessoa_cents || 0;

  if (HAS_PRECO_COL) {
    // soma por convidado: usa override (preco_cents) quando existir; senão usa o preço base do jantar
    const agg = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(base, j.id);
    if (!agg || !agg.n) return (j.pessoas || 0) * base; // fallback se ainda não há convidados
    return agg.s || 0;
  }

  // sem coluna preco_cents: fallback
  const n = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id)?.n || 0;
  return (n ? n : (j.pessoas || 0)) * base;
}

/* -------------------- LISTAR -------------------- */
router.get('/jantares', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT
        id,
        COALESCE(dt,'')                    AS dt,
        COALESCE(title,'')                 AS title,
        COALESCE(pessoas,0)                AS pessoas,
        COALESCE(valor_pessoa_cents,0)     AS valor_pessoa_cents,
        COALESCE(despesas_cents,0)         AS despesas_cents
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

    res.render('jantares', { jantares, totalReceita, totalDespesas, totalLucro, euros, user: req.session.user });
  } catch (e) { next(e); }
});

/* -------------------- FORM NOVO -------------------- */
router.get('/jantares/new', requireAuth, (_req, res) => res.render('jantares_new'));

/* -------------------- CRIAR -------------------- */
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

/* -------------------- EDITAR -------------------- */
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

/* -------------------- ATUALIZAR -------------------- */
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

/* -------------------- APAGAR -------------------- */
router.post('/jantares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM jantares WHERE id=?`).run(req.params.id);
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

export default router;
