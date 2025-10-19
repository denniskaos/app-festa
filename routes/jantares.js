// routes/jantares.js (ESM)
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

console.log('[routes] jantares (CRUD) carregado');

const router = Router();

/* -------- helpers -------- */
// Descobre uma vez se a coluna preco_cents existe (compatibilidade com DB antigas)
const HAS_PRECO_COL = (() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    return cols.includes('preco_cents');
  } catch {
    return false;
  }
})();

function receitaPorJantarCents(j) {
  const base = j.valor_pessoa_cents || 0;

  if (HAS_PRECO_COL) {
    // Soma por convidado usando override (preco_cents) ou o preço base do jantar
    const agg = db.prepare(`
      SELECT 
        COUNT(*) AS n,
        COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(base, j.id);

    // Se não houver convidados, usa o cálculo antigo (pessoas × preço base)
    if (!agg || !agg.n) return (j.pessoas || 0) * base;
    return agg.s || 0;
  }

  // Compat: sem coluna preco_cents → tenta contar convidados; senão, usa pessoas
  const n = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id)?.n || 0;
  return (n > 0 ? n : (j.pessoas || 0)) * base;
}

/* LISTAR */
router.get('/jantares', requireAuth, (req, res, next) => {
  try {
    const jantaresRaw = db.prepare(`
      SELECT
        id,
        COALESCE(dt, '')                 AS dt,
        COALESCE(pessoas, 0)             AS pessoas,
        COALESCE(valor_pessoa_cents, 0)  AS valor_pessoa_cents,
        COALESCE(despesas_cents, 0)      AS despesas_cents
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

    const jantares = jantaresRaw.map(j => {
      const receita_cents = receitaPorJantarCents(j);
      const lucro_cents   = receita_cents - (j.despesas_cents || 0);
      return { ...j, receita_cents, lucro_cents };
    });

    const totalReceita  = jantares.reduce((a, r) => a + r.receita_cents, 0);
    const totalDespesas = jantares.reduce((a, r) => a + r.despesas_cents, 0);
    const totalLucro    = totalReceita - totalDespesas;

    res.render('jantares', {
      title: 'Jantares',
      jantares,
      totalReceita,
      totalDespesas,
      totalLucro,
      euros,
      user: req.session.user,
    });
  } catch (e) { next(e); }
});

/* FORM NOVO (usa views/jantares_form.ejs) */
router.get('/jantares/new', requireAuth, (_req, res) => {
  res.render('jantares_form', { title: 'Novo jantar', j: null, euros, user: _req.session.user });
});

/* CRIAR */
router.post('/jantares', requireAuth, (req, res, next) => {
  try {
    const { dt, pessoas, valor_pessoa, despesas } = req.body;
    db.prepare(`
      INSERT INTO jantares (dt, pessoas, valor_pessoa_cents, despesas_cents)
      VALUES (?,?,?,?)
    `).run(
      (dt || '').trim() || null,
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas)
    );
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* EDITAR (usa o mesmo form) */
router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = db.prepare(`
      SELECT id,
             COALESCE(dt,'')                    AS dt,
             COALESCE(pessoas,0)                AS pessoas,
             COALESCE(valor_pessoa_cents,0)     AS valor_pessoa_cents,
             COALESCE(despesas_cents,0)         AS despesas_cents
      FROM jantares
      WHERE id=?
    `).get(req.params.id);

    if (!j) return res.status(404).type('text').send('Jantar não encontrado');

    res.render('jantares_form', { title: `Editar jantar #${j.id}`, j, euros, user: req.session.user });
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
      (dt || '').trim() || null,
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



