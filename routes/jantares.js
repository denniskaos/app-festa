// routes/jantares.js
import { Router } from 'express';
import db, { cents, euros } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ---------- Migrações defensivas (runtime) ---------- */
(function ensureSchema() {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares')`).all().map(c => c.name);
    const ensure = (name, def) => {
      if (!cols.includes(name)) {
        db.exec(`ALTER TABLE jantares ADD COLUMN ${name} ${def}`);
        cols.push(name);
      }
    };
    ensure('title', 'TEXT');
  } catch (e) {
    console.error('[jantares] falha ao garantir esquema:', e);
  }
})();

/* ---------- Helpers ---------- */
function getJantarOr404(id) {
  const j = db.prepare(`SELECT * FROM jantares WHERE id=?`).get(id);
  if (!j) {
    const err = new Error('Jantar não encontrado');
    err.status = 404;
    throw err;
  }
  return j;
}

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
    const agg = db.prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(base, j.id);
    if (!agg || !agg.n) return (j.pessoas || 0) * base;
    return agg.s || 0;
  }

  const row = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id);
  const convidados = row?.n || 0;
  if (convidados > 0) return convidados * base;
  return (j.pessoas || 0) * base;
}

function normalizarTexto(v) {
  const txt = (v ?? '').toString().trim();
  return txt.length ? txt : null;
}

function normalizarData(v) {
  const txt = (v ?? '').toString().trim();
  return txt.length ? txt : null;
}

function normalizarInteiro(v) {
  const n = parseInt((v ?? '0').toString(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizarCents(v) {
  const value = cents(v);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/* ---------- Rotas ---------- */
router.get('/jantares', requireAuth, (_req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents, lancado
      FROM jantares
      ORDER BY (dt IS NULL), date(dt) DESC, id DESC
    `).all();

    const jantares = rows.map(row => ({
      ...row,
      receita_cents: receitaPorJantarCents(row),
    }));

    const totalReceita = jantares.reduce((sum, j) => sum + (j.receita_cents || 0), 0);
    const totalDespesas = jantares.reduce((sum, j) => sum + (j.despesas_cents || 0), 0);
    const totalLucro = totalReceita - totalDespesas;

    res.render('jantares', {
      title: 'Jantares',
      jantares,
      euros,
      totalReceita,
      totalDespesas,
      totalLucro,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/jantares/new', requireAuth, (_req, res) => {
  res.render('jantares_new', { title: 'Novo Jantar', euros });
});

router.post('/jantares', requireAuth, (req, res, next) => {
  try {
    const title = normalizarTexto(req.body.title);
    const dt = normalizarData(req.body.dt);
    const pessoas = normalizarInteiro(req.body.pessoas);
    const valorPessoa = normalizarCents(req.body.valor_pessoa);
    const despesas = normalizarCents(req.body.despesas);

    db.prepare(`
      INSERT INTO jantares (title, dt, pessoas, valor_pessoa_cents, despesas_cents)
      VALUES (?,?,?,?,?)
    `).run(title, dt, pessoas, valorPessoa, despesas);

    res.redirect('/jantares');
  } catch (e) {
    next(e);
  }
});

router.get('/jantares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    res.render('jantares_edit', { title: 'Editar Jantar', j, euros });
  } catch (e) {
    next(e);
  }
});

router.post('/jantares/:id', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const title = normalizarTexto(req.body.title);
    const dt = normalizarData(req.body.dt);
    const pessoas = normalizarInteiro(req.body.pessoas);
    const valorPessoa = normalizarCents(req.body.valor_pessoa);
    const despesas = normalizarCents(req.body.despesas);

    db.prepare(`
      UPDATE jantares
         SET title=?, dt=?, pessoas=?, valor_pessoa_cents=?, despesas_cents=?
       WHERE id=?
    `).run(title, dt, pessoas, valorPessoa, despesas, j.id);

    res.redirect('/jantares');
  } catch (e) {
    next(e);
  }
});

router.post('/jantares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM jantares WHERE id=?`).run(req.params.id);
    res.redirect('/jantares');
  } catch (e) {
    next(e);
  }
});

export default router;
