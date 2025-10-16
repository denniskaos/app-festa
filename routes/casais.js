// routes/casais.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// --- util robusto para somas (se a tabela não existir, devolve 0)
function sumOr0(sql) {
  try { return db.prepare(sql).get()?.s ?? 0; } catch { return 0; }
}

function calcularReceitaLiquida() {
  // Movimentos (receita - despesa)
  const recMov  = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                          FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                          WHERE c.type='receita'`);
  const despMov = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                          FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                          WHERE c.type='despesa'`);
  // Jantares
  const recJ    = sumOr0(`SELECT COALESCE(SUM(pessoas*valor_pessoa_cents),0) AS s FROM jantares`);
  const despJ   = sumOr0(`SELECT COALESCE(SUM(despesas_cents),0) AS s FROM jantares`);
  // Peditórios e Patrocinadores (entregue)
  const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
  const patEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);

  return recMov + recJ + ped + patEnt - (despMov + despJ);
}

// --- debug rápido
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
    const c = db.prepare(`SELECT id, nome, COALESCE(valor_casa_cents,0) AS valor_casa_cents FROM casais WHERE id=?`)
      .get(req.params.id);
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

/* ========== RODÍZIO (5.000 € por bloco, atribuição 1 bloco a cada casal) ========== */

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

    const net = calcularReceitaLiquida();
    const blocosTotais = Math.floor(net / bloco);
    const novosBlocos = Math.max(blocosTotais - aplicados, 0);
    const resto = net - blocosTotais * bloco;

    const startIdx = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    const atribuicoes = Array(casais.length).fill(0);
    for (let k = 0, i = startIdx; k < novosBlocos && casais.length > 0; k++, i = (i + 1) % casais.length) {
      atribuicoes[i] += 1;
    }

    const linhas = casais.map((c, idx) => ({
      ...c,
      alvo: c.atual + atribuicoes[idx] * bloco,
      novos_blocks: atribuicoes[idx]
    }));

    res.render('casais_rodizio', {
      linhas, bloco, blocosTotais, novosBlocos, resto, inicioId, euros, user: req.session.user
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
    if (casais.length === 0) return res.redirect('/casais/rodizio');

    const net = calcularReceitaLiquida();
    const blocosTotais = Math.floor(net / bloco);
    const novosBlocos = Math.max(blocosTotais - aplicados, 0);
    if (novosBlocos === 0) return res.redirect('/casais/rodizio');

    const startIdx = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    const atribuicoes = Array(casais.length).fill(0);
    for (let k = 0, i = startIdx; k < novosBlocos; k++, i = (i + 1) % casais.length) {
      atribuicoes[i] += 1;
    }

    const tx = db.transaction(() => {
      for (let i = 0; i < casais.length; i++) {
        const blocks = atribuicoes[i];
        if (blocks > 0) {
          db.prepare(`UPDATE casais SET valor_casa_cents = valor_casa_cents + ? WHERE id=?`)
            .run(blocks * bloco, casais[i].id);
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
