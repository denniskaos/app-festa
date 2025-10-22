// routes/casais.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { loadRodizioResumo } from '../lib/rodizio.js';

const router = Router();

/* ================== helpers ================== */

/* ================== CRUD Casais ================== */

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

router.get('/casais/new', requireAuth, (_req, res) => res.render('casais_new'));

router.post('/casais', requireAuth, (req, res, next) => {
  try {
    const { nome, valor } = req.body;
    db.prepare(`INSERT INTO casais (nome, valor_casa_cents) VALUES (?, ?)` )
      .run((nome || '').trim(), cents(valor));
    res.redirect('/casais');
  } catch (e) { next(e); }
});

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

router.post('/casais/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM casais WHERE id=?`).run(req.params.id);
    res.redirect('/casais');
  } catch (e) { next(e); }
});

/* ================== Rodízio ================== */

// ecrã do rodízio: mostra blocos completos, NOVOS blocos por aplicar e **RESTO DISPONÍVEL**
router.get('/casais/rodizio', requireAuth, (req, res, next) => {
  try {
    const {
      settings: st,
      casaisTarget: bloco,
      saldoMovimentos: net,
      aplicadoResto,
      restoDisponivel,
    } = loadRodizioResumo();

    const inicioId   = st.rodizio_inicio_casal_id ?? null;
    const aplicados  = Number(st.rodizio_blocks_aplicados ?? 0); // blocos já aplicados a casais
    const blocoCents = bloco > 0 ? bloco : 0;

    const casais = db.prepare(`
      SELECT id, nome, COALESCE(valor_casa_cents,0) AS atual
      FROM casais
      ORDER BY id
    `).all();

    // blocos que cabem nesse valor "net"
    const blocosCompletos = blocoCents > 0 ? Math.floor(net / blocoCents) : 0;

    // blocos ainda por aplicar (do total que cabem até hoje)
    const novosBlocos = Math.max(blocosCompletos - aplicados, 0);

    // distribuição ciclíca dos novos blocos a partir do casal definido
    const startIdx = Math.max(0, inicioId ? casais.findIndex(c => c.id === inicioId) : 0);
    const atribuicoes = Array(casais.length).fill(0);
    for (let k = 0, i = startIdx; k < novosBlocos && casais.length > 0; k++, i = (i + 1) % casais.length) {
      atribuicoes[i] += 1;
    }

    const linhas = casais.map((c, idx) => ({
      ...c,
      novos_blocks: atribuicoes[idx],
      alvo: c.atual + atribuicoes[idx] * blocoCents
    }));

    res.render('casais_rodizio', {
      linhas,
      bloco: blocoCents,
      blocosCompletos,
      novosBlocos,
      restoDisponivel,        // <-- só mostramos este “resto”
      inicioId,
      euros,
      user: req.session.user
    });
  } catch (e) { next(e); }
});

// definir o casal de início da sequência
router.post('/casais/rodizio/inicio', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.body.casal_id) || null;
    db.prepare(`UPDATE settings SET rodizio_inicio_casal_id=? WHERE id=1`).run(id);
    res.redirect('/casais/rodizio');
  } catch (e) { next(e); }
});

// aplicar e persistir os novos blocos
router.post('/casais/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const {
      settings: st,
      casaisTarget: bloco,
      saldoMovimentos: net,
    } = loadRodizioResumo();
    const inicioId  = st.rodizio_inicio_casal_id ?? null;
    const aplicados = Number(st.rodizio_blocks_aplicados ?? 0);

    const casais = db.prepare(`SELECT id FROM casais ORDER BY id`).all();
    if (casais.length === 0) return res.redirect('/casais/rodizio');

    const blocoCents = bloco > 0 ? bloco : 0;
    const blocosCompletos = blocoCents > 0 ? Math.floor(net / blocoCents) : 0;
    const novosBlocos = Math.max(blocosCompletos - aplicados, 0);
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
            .run(blocks * blocoCents, casais[i].id);
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
