// routes/casais.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ============================= helpers ============================= */

function sumOr0(sql, ...params) {
  try {
    const row = db.prepare(sql).get(...params);
    return row?.s ?? 0;
  } catch {
    return 0;
  }
}

// total pago (todos os jantares)
function sumPagoJantares() {
  return sumOr0(`SELECT COALESCE(SUM(pago_cents),0) AS s FROM jantares_convidados`);
}

// total pago por jantar
function sumPagoPorJantar(jantarId) {
  return sumOr0(
    `SELECT COALESCE(SUM(pago_cents),0) AS s FROM jantares_convidados WHERE jantar_id=?`,
    jantarId
  );
}

// despesas totais registadas nos jantares
function sumDespesasJantares() {
  return sumOr0(`SELECT COALESCE(SUM(despesas_cents),0) AS s FROM jantares`);
}

// saldo em “movimentos” (receitas − despesas) + peditórios + patrocínios (entregue)
function calcularSaldoMovimentos() {
  const recMov  = sumOr0(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS s
    FROM movimentos m
    JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='receita'
  `);
  const despMov = sumOr0(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS s
    FROM movimentos m
    JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='despesa'
  `);
  const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
  const patEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
  return recMov - despMov + ped + patEnt;
}

// tentativa razoável para saber se um jantar já foi lançado para movimentos:
// procura um movimento de RECEITA na data do jantar cuja categoria seja “Jantar…” e
// a descrição comece por “Jantar — ”
function isJantarLancado(j) {
  if (!j.dt) return false;
  try {
    const row = db.prepare(`
      SELECT 1 AS ok
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
        AND (c.name LIKE 'Jantar%' OR c.name LIKE 'Jantares%')
        AND m.dt IS ?
        AND (m.descr LIKE 'Jantar — %' OR m.descr LIKE 'Jantar%')
      LIMIT 1
    `).get(j.dt);
    return !!row?.ok;
  } catch {
    return false;
  }
}

// lucro projetado apenas dos jantares ainda NÃO lançados:
// soma (total pago pelos convidados desse jantar − despesas_cents do jantar)
function calcularLucroProjetadoJantaresPendentes() {
  let total = 0;
  const jantares = db.prepare(`
    SELECT id, dt, COALESCE(despesas_cents,0) AS despesas_cents
    FROM jantares
  `).all();

  for (const j of jantares) {
    if (isJantarLancado(j)) continue;
    const pago = sumPagoPorJantar(j.id);
    total += (pago - (j.despesas_cents || 0));
  }
  return total;
}

/* ============================ rotas base ============================ */

// debug
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
      FROM casais
      WHERE id=?
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

/* ======================= RODÍZIO (blocos) =======================

Fórmula usada:
- saldoMov = receitas(movimentos) − despesas(movimentos) + peditórios + patrocínios
- lucroProjPendentes = Σ (total pago do jantar − despesas do jantar) [apenas jantares não lançados]
- saldoProjetado = saldoMov + lucroProjPendentes
- blocosTotais = floor(saldoProjetado / bloco)
- restoTeorico = saldoProjetado − (blocosTotais * bloco)

Distribuição: apenas dos blocos NOVOS (blocosTotais − blocksAplicados),
respeitando o início configurado.
================================================================= */

// ecrã do rodízio
router.get('/casais/rodizio', requireAuth, (req, res, next) => {
  try {
    const st = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
    const bloco      = Number(st.rodizio_bloco_cents ?? 500000); // 5.000 €
    const inicioId   = st.rodizio_inicio_casal_id ?? null;
    const aplicados  = Number(st.rodizio_blocks_aplicados ?? 0);

    // saldo de movimentos + patrocínios + peditórios
    const saldoMov = calcularSaldoMovimentos();

    // lucro projetado só dos jantares PENDENTES (receita = total pago)
    const lucroProjPendentes = calcularLucroProjetadoJantaresPendentes();

    const saldoProjetado = saldoMov + lucroProjPendentes;

    const blocosTotais    = bloco > 0 ? Math.floor(saldoProjetado / bloco) : 0;
    const restoTeorico    = saldoProjetado - blocosTotais * bloco;
    const novosBlocos     = Math.max(blocosTotais - aplicados, 0);

    const casais = db.prepare(`
      SELECT id, nome, COALESCE(valor_casa_cents,0) AS atual
      FROM casais
      ORDER BY id
    `).all();

    // roda a atribuição a partir do casal inicial
    const startIdx = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    const atribuicoes = Array(casais.length).fill(0);
    if (casais.length > 0) {
      for (let k = 0, i = startIdx; k < novosBlocos; k++, i = (i + 1) % casais.length) {
        atribuicoes[i] += 1;
      }
    }

    const linhas = casais.map((c, idx) => ({
      ...c,
      novos_blocks: atribuicoes[idx],
      alvo: c.atual + atribuicoes[idx] * bloco
    }));

    // Aliases para a view antiga (evita crash):
    // - blocosCompletos (== blocosTotais)
    // - resto (== restoTeorico)
    res.render('casais_rodizio', {
      linhas,
      bloco,
      inicioId,
      // nomes "novos"
      blocosTotais,
      novosBlocos,
      restoTeorico,
      // aliases esperados pela EJS antiga
      blocosCompletos: blocosTotais,
      resto: restoTeorico,
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
    const bloco      = Number(st.rodizio_bloco_cents ?? 500000);
    const inicioId   = st.rodizio_inicio_casal_id ?? null;
    const aplicados  = Number(st.rodizio_blocks_aplicados ?? 0);

    const saldoMov           = calcularSaldoMovimentos();
    const lucroProjPendentes = calcularLucroProjetadoJantaresPendentes();
    const saldoProjetado     = saldoMov + lucroProjPendentes;

    const blocosTotais = bloco > 0 ? Math.floor(saldoProjetado / bloco) : 0;
    const novosBlocos  = Math.max(blocosTotais - aplicados, 0);
    if (novosBlocos === 0) return res.redirect('/casais/rodizio');

    const casais = db.prepare(`SELECT id FROM casais ORDER BY id`).all();
    if (casais.length === 0) return res.redirect('/casais/rodizio');

    const startIdx = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    const atribuicoes = Array(casais.length).fill(0);
    for (let k = 0, i = startIdx; k < novosBlocos; k++, i = (i + 1) % casais.length) {
      atribuicoes[i] += 1;
    }

    const tx = db.transaction(() => {
      for (let i = 0; i < casais.length; i++) {
        const blocks = atribuicoes[i];
        if (blocks > 0) {
          db.prepare(`
            UPDATE casais
               SET valor_casa_cents = valor_casa_cents + ?
             WHERE id=?
          `).run(blocks * bloco, casais[i].id);
        }
      }
      db.prepare(`
        UPDATE settings
           SET rodizio_blocks_aplicados = rodizio_blocks_aplicados + ?
         WHERE id=1
      `).run(novosBlocos);
    });
    tx();

    res.redirect('/casais/rodizio');
  } catch (e) { next(e); }
});

export default router;
