// routes/casais.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ------------------ helpers ------------------ */

// soma defensiva (se a tabela não existir, devolve 0)
function sumOr0(sql) {
  try { return db.prepare(sql).get()?.s ?? 0; } catch { return 0; }
}

// etiqueta amigável do jantar
function etiquetaJantar(j) {
  return (j.title && j.title.trim()) ? j.title.trim() : (j.dt || `Jantar #${j.id}`);
}

// receita *paga* do jantar (usa SUM(pago_cents)); se não houver convidados, faz fallback
function receitaPagaJantar(j) {
  const agg = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(pago_cents), 0) AS s
    FROM jantares_convidados
    WHERE jantar_id=?
  `).get(j.id);
  if (agg && agg.n > 0) return agg.s || 0;
  // modo antigo (sem convidados registados)
  return (j.pessoas || 0) * (j.valor_pessoa_cents || 0);
}

// considerar “lançado” se existir movimento de Receita do jantar
function jantarLancado(j) {
  const cat = db.prepare(`SELECT id FROM categorias WHERE type='receita' AND name='Jantares'`).get();
  if (!cat?.id) return false;
  const novo = `Jantar — ${etiquetaJantar(j)} — Receita`;
  const antigo = `Jantar ${j.dt || ('#'+j.id)} (ID:${j.id}) — Receita`;
  const hit = db.prepare(`
    SELECT 1 ok FROM movimentos
    WHERE categoria_id=? AND (descr LIKE ? OR descr LIKE ?) LIMIT 1
  `).get(cat.id, `${novo}%`, `${antigo}%`);
  return !!hit?.ok;
}

/* ------------------ rotas ------------------ */

// debug simples
router.get('/casais/ping', (_req, res) => res.type('text').send('ok'));

/* LISTAR */
router.get('/casais', requireAuth, (req, res, next) => {
  try {
    const casais = db.prepare(`
      SELECT id, nome, COALESCE(valor_casa_cents,0) AS valor_casa_cents
      FROM casais
      ORDER BY nome COLLATE NOCASE
    `).all();
    const total = casais.reduce((a, c) => a + (c.valor_casa_cents || 0), 0);
    res.render('casais', { casais, total, euros, user: req.session.user });
  } catch (e) { next(e); }
});

/* NOVO */
router.get('/casais/new', requireAuth, (_req, res) => res.render('casais_new'));
router.post('/casais', requireAuth, (req, res, next) => {
  try {
    const { nome, valor } = req.body;
    db.prepare(`INSERT INTO casais (nome, valor_casa_cents) VALUES (?, ?)` )
      .run((nome || '').trim(), cents(valor));
    res.redirect('/casais');
  } catch (e) { next(e); }
});

/* EDITAR */
router.get('/casais/:id/edit', requireAuth, (req, res, next) => {
  try {
    const c = db.prepare(`
      SELECT id, nome, COALESCE(valor_casa_cents,0) AS valor_casa_cents
      FROM casais WHERE id=?
    `).get(req.params.id);
    if (!c) return res.status(404).send('Casal não encontrado');
    res.render('casais_edit', { c, euros });
  } catch (e) { next(e); }
});
router.post('/casais/:id', requireAuth, (req, res, next) => {
  try {
    const { nome, valor } = req.body;
    db.prepare(`UPDATE casais SET nome=?, valor_casa_cents=? WHERE id=?`)
      .run((nome || '').trim(), cents(valor), req.params.id);
    res.redirect('/casais');
  } catch (e) { next(e); }
});

/* APAGAR */
router.post('/casais/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM casais WHERE id=?`).run(req.params.id);
    res.redirect('/casais');
  } catch (e) { next(e); }
});

/* ========== RODÍZIO (distribuição por blocos) ========== */
/**
 * Fórmulas:
 *  - saldoMovimentos = receitas(mov) − despesas(mov) + peditórios + patrocínios
 *  - lucroProjetado  = Σ (receita paga − despesas) dos jantares NÃO lançados
 *  - saldoProjetado  = saldoMovimentos + lucroProjetado
 *  - blocosTotais    = floor(saldoProjetado / bloco)
 *  - novosBlocos     = max(blocosTotais − blocks_aplicados, 0)
 *  - resto           = saldoProjetado − blocosTotais × bloco
 */

// ecrã do rodízio
router.get('/casais/rodizio', requireAuth, (req, res, next) => {
  try {
    const st = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
    const bloco = Number(st.rodizio_bloco_cents ?? 500000);        // 5.000 €
    const inicioId = st.rodizio_inicio_casal_id ?? null;
    const aplicados = Number(st.rodizio_blocks_aplicados ?? 0);

    const casais = db.prepare(`
      SELECT id, nome, COALESCE(valor_casa_cents,0) AS atual
      FROM casais
      ORDER BY id
    `).all();

    // 1) saldo de movimentos (com peditórios e patrocínios)
    const recMov  = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                            FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                            WHERE c.type='receita'`);
    const despMov = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                            FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                            WHERE c.type='despesa'`);
    const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
    const patEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = recMov - despMov + ped + patEnt;

    // 2) lucro projetado dos jantares (pendentes) — usa o que foi PAGO
    const jantares = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents
      FROM jantares
      ORDER BY id
    `).all();

    let lucroProjetado = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue;
      const receitaPaga = receitaPagaJantar(j);
      lucroProjetado += (receitaPaga - (j.despesas_cents || 0));
    }

    // 3) saldo projetado
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // 4) blocos/novo resto
    let blocosTotais = 0, novosBlocos = 0, resto = saldoProjetado;
    if (bloco > 0) {
      blocosTotais = Math.floor(saldoProjetado / bloco);
      novosBlocos  = Math.max(blocosTotais - aplicados, 0);
      resto        = saldoProjetado - blocosTotais * bloco;
    }

    // 5) distribuição circular dos novos blocos
    const atribuicoes = Array(casais.length).fill(0);
    if (casais.length && novosBlocos > 0) {
      let i = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
      if (i < 0) i = 0;
      for (let k = 0; k < novosBlocos; k++, i = (i + 1) % casais.length) {
        atribuicoes[i] += 1;
      }
    }

    const linhas = casais.map((c, idx) => ({
      ...c,
      novos_blocks: atribuicoes[idx],
      alvo: c.atual + atribuicoes[idx] * (bloco > 0 ? bloco : 0)
    }));

    res.render('casais_rodizio', {
      linhas,
      bloco,
      blocosTotais,
      novosBlocos,
      resto,
      inicioId,
      euros,
      user: req.session.user
    });
  } catch (e) { next(e); }
});

// definir início do rodízio
router.post('/casais/rodizio/inicio', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.body.casal_id) || null;
    db.prepare(`UPDATE settings SET rodizio_inicio_casal_id=? WHERE id=1`).run(id);
    res.redirect('/casais/rodizio');
  } catch (e) { next(e); }
});

// aplicar distribuição dos blocos novos (persiste)
router.post('/casais/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const st = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
    const bloco = Number(st.rodizio_bloco_cents ?? 500000);
    const inicioId = st.rodizio_inicio_casal_id ?? null;
    const aplicados = Number(st.rodizio_blocks_aplicados ?? 0);

    const casais = db.prepare(`SELECT id FROM casais ORDER BY id`).all();
    if (!casais.length || bloco <= 0) return res.redirect('/casais/rodizio');

    // (re)calcular como no GET
    const recMov  = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                            FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                            WHERE c.type='receita'`);
    const despMov = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                            FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                            WHERE c.type='despesa'`);
    const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
    const patEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = recMov - despMov + ped + patEnt;

    const jantares = db.prepare(`SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents FROM jantares`).all();
    let lucroProjetado = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue;
      const receitaPaga = receitaPagaJantar(j);
      lucroProjetado += (receitaPaga - (j.despesas_cents || 0));
    }
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    const blocosTotais = Math.floor(saldoProjetado / bloco);
    const novosBlocos  = Math.max(blocosTotais - aplicados, 0);
    if (novosBlocos <= 0) return res.redirect('/casais/rodizio');

    const atribuicoes = Array(casais.length).fill(0);
    let i = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    if (i < 0) i = 0;
    for (let k = 0; k < novosBlocos; k++, i = (i + 1) % casais.length) atribuicoes[i] += 1;

    const tx = db.transaction(() => {
      for (let idx = 0; idx < casais.length; idx++) {
        const blocks = atribuicoes[idx];
        if (blocks > 0) {
          db.prepare(`UPDATE casais SET valor_casa_cents = valor_casa_cents + ? WHERE id=?`)
            .run(blocks * bloco, casais[idx].id);
        }
      }
      db.prepare(`UPDATE settings SET rodizio_blocks_aplicados = rodizio_blocks_aplicados + ? WHERE id=1`)
        .run(novosBlocos);
    });
    tx();

    res.redirect('/casais/rodizio');
  } catch (e) { next(e); }
});

export default router;
