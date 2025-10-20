// routes/jantares.js (ESM)
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

console.log('[routes] jantares (CRUD) carregado');

const router = Router();

 HEAD
/* -------- helpers -------- */
// Descobre uma vez se a coluna preco_cents existe (compatibilidade com DB antigas)

/* -------------------------------------------------------
   Migrações defensivas (em runtime)
------------------------------------------------------- */
// Garante que a coluna "title" existe em jantares
(() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares')`).all().map(c => c.name);
    if (!cols.includes('title')) {
      db.exec(`ALTER TABLE jantares ADD COLUMN title TEXT`);
    }
  } catch { /* ignore */ }
})();

// Detecta se existe a coluna "preco_cents" em jantares_convidados
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
const HAS_PRECO_COL = (() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    return cols.includes('preco_cents');
 HEAD
  } catch {
    return false;
  }
})();


  } catch { return false; }
})();

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */
// Receita do jantar (em cents).
// - Se existir "preco_cents" nos convidados: soma override ou preço base quando nulo.
// - Se não existir a coluna: usa contagem de convidados × preço base;
//   se ainda não houver convidados, usa pessoas × preço base.
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
function receitaPorJantarCents(j) {
  const base = j.valor_pessoa_cents || 0;

  if (HAS_PRECO_COL) {
 HEAD
    // Soma por convidado usando override (preco_cents) ou o preço base do jantar
    const agg = db.prepare(`
      SELECT 
        COUNT(*) AS n,
        COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s

    const agg = db.prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(base, j.id);

 HEAD
    // Se não houver convidados, usa o cálculo antigo (pessoas × preço base)
    
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
    if (!agg || !agg.n) return (j.pessoas || 0) * base;
    return agg.s || 0;
  }
HEAD
  // Compat: sem coluna preco_cents → tenta contar convidados; senão, usa pessoas
  const n = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id)?.n || 0;
  return (n > 0 ? n : (j.pessoas || 0)) * base;
}

/* LISTAR */

  const n = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id)?.n || 0;
  const count = n > 0 ? n : (j.pessoas || 0);
  return count * base;
}

/* -------------------------------------------------------
   LISTAR
------------------------------------------------------- */
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
router.get('/jantares', requireAuth, (req, res, next) => {
  try {
    const jantaresRaw = db.prepare(`
      SELECT
        id,
 HEAD
        COALESCE(dt, '')                 AS dt,
        COALESCE(pessoas, 0)             AS pessoas,
        COALESCE(valor_pessoa_cents, 0)  AS valor_pessoa_cents,
        COALESCE(despesas_cents, 0)      AS despesas_cents

        COALESCE(dt,'')                AS dt,
        COALESCE(title,'')             AS title,
        COALESCE(pessoas,0)            AS pessoas,
        COALESCE(valor_pessoa_cents,0) AS valor_pessoa_cents,
        COALESCE(despesas_cents,0)     AS despesas_cents
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

 HEAD
    const jantares = jantaresRaw.map(j => {
      const receita_cents = receitaPorJantarCents(j);
      const lucro_cents   = receita_cents - (j.despesas_cents || 0);
      return { ...j, receita_cents, lucro_cents };

    const jantares = rows.map(r => {
      const receita_cents = receitaPorJantarCents(r);
      const lucro_cents   = receita_cents - (r.despesas_cents || 0);
      return { ...r, receita_cents, lucro_cents };
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
    });

    const totalReceita  = jantares.reduce((a, r) => a + r.receita_cents, 0);
    const totalDespesas = jantares.reduce((a, r) => a + r.despesas_cents, 0);
    const totalLucro    = totalReceita - totalDespesas;

    res.render('jantares', {
 HEAD
      title: 'Jantares',

 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      jantares,
      totalReceita,
      totalDespesas,
      totalLucro,
      euros,
      user: req.session.user,
    });
  } catch (e) { next(e); }
});

 HEAD
/* FORM NOVO (usa views/jantares_form.ejs) */

/* -------------------------------------------------------
   NOVO
------------------------------------------------------- */
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
router.get('/jantares/new', requireAuth, (_req, res) => {
  res.render('jantares_form', { title: 'Novo jantar', j: null, euros, user: _req.session.user });
});

/* -------------------------------------------------------
   CRIAR
------------------------------------------------------- */
router.post('/jantares', requireAuth, (req, res, next) => {
  try {
    const { dt, title, pessoas, valor_pessoa, despesas } = req.body;

    db.prepare(`
      INSERT INTO jantares (dt, title, pessoas, valor_pessoa_cents, despesas_cents)
      VALUES (?,?,?,?,?)
    `).run(
 HEAD
      (dt || '').trim() || null,
      (String(dt || '').trim() || null),
      (String(title || '').trim() || null),
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas)
    );

    res.redirect('/jantares');
  } catch (e) { next(e); }
});

HEAD
/* EDITAR (usa o mesmo form) */
router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = db.prepare(`
      SELECT id,
             COALESCE(dt,'')                    AS dt,
             COALESCE(pessoas,0)                AS pessoas,
             COALESCE(valor_pessoa_cents,0)     AS valor_pessoa_cents,
             COALESCE(despesas_cents,0)         AS despesas_cents

/* -------------------------------------------------------
   EDITAR
------------------------------------------------------- */
router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = db.prepare(`
      SELECT
        id,
        COALESCE(dt,'')                AS dt,
        COALESCE(title,'')             AS title,
        COALESCE(pessoas,0)            AS pessoas,
        COALESCE(valor_pessoa_cents,0) AS valor_pessoa_cents,
        COALESCE(despesas_cents,0)     AS despesas_cents
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      FROM jantares
      WHERE id=?
    `).get(req.params.id);

 HEAD
    if (!j) return res.status(404).type('text').send('Jantar não encontrado');

    res.render('jantares_form', { title: `Editar jantar #${j.id}`, j, euros, user: req.session.user });

    if (!j) return res.status(404).send('Jantar não encontrado');

    res.render('jantares_edit', { j, euros, user: req.session.user });
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
  } catch (e) { next(e); }
});

/* -------------------------------------------------------
   ATUALIZAR
------------------------------------------------------- */
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
 HEAD
      (dt || '').trim() || null,

      (String(dt || '').trim() || null),
      (String(title || '').trim() || null),
 8e055a6 (feat(jantares): prefixo 'Jantar — …' nos movimentos + redirecionamento 303 + cabeçalhos consistentes)
      Number(pessoas || 0),
      cents(valor_pessoa),
      cents(despesas),
      req.params.id
    );

    res.redirect('/jantares');
  } catch (e) { next(e); }
});

/* -------------------------------------------------------
   APAGAR
------------------------------------------------------- */
router.post('/jantares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM jantares WHERE id=?`).run(req.params.id);
    res.redirect('/jantares');
  } catch (e) { next(e); }
});

export default router;



