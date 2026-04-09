// routes/casais.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { adjustCasalValor, loadRodizioResumo } from '../lib/rodizio.js';

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
    const {
      saldoMovimentos,
      lucroProjetado,
      saldoProjetado,
      totalCasais,
      aplicadoResto,
      restoTeorico,
      restoDisponivel,
    } = loadRodizioResumo();

    res.render('casais', {
      casais,
      total,
      resumo: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasaCents: totalCasais,
        aplicadoResto,
        restoTeorico,
        restoDisponivel,
      },
      euros,
      user: req.session.user
    });
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
router.get('/casais/rodizio', requireAuth, (req, res, next) => {
  try {
    const {
      settings,
      saldoMovimentos,
      lucroProjetado,
      saldoProjetado,
      aplicadoResto,
      totalCasais,
      restoTeorico,
      restoDisponivel,
    } = loadRodizioResumo();

    const casais = db.prepare(`SELECT id,nome FROM casais ORDER BY nome COLLATE NOCASE`).all();
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      euros,
      settings,
      casais,
      historico,
      basePath: '/casais/rodizio',
      resumo: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasaCents: totalCasais,
        restoTeorico,
        aplicadoResto,
        restoDisponivel,
      },
      msg: req.query.msg || null,
      err: req.query.err || null,
    });
  } catch (e) { next(e); }
});

router.post('/casais/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = Math.round(parseFloat(String(req.body.bloco || '').replace(',', '.')) * 100) || 0;
    const inicioId = Number(req.body.inicio_casal_id) || null;
    db.prepare(`
      UPDATE settings
      SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
      WHERE id=1
    `).run(blocoCents, inicioId);
    res.redirect('/casais/rodizio?msg=Definições+atualizadas');
  } catch (e) { next(e); }
});

router.post('/casais/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id);
    const valor = parseFloat(String(req.body.valor || '').replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);

    if (!casal_id) return res.redirect('/casais/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/casais/rodizio?err=Valor+inválido');

    const { restoDisponivel } = loadRodizioResumo();
    if (valor_cents > restoDisponivel + 5) {
      return res.redirect('/casais/rodizio?err=Valor+excede+o+resto+disponível');
    }

    const casal = db.prepare('SELECT id FROM casais WHERE id=?').get(casal_id);
    if (!casal) return res.redirect('/casais/rodizio?err=Casal+inexistente');

    const tx = db.transaction(() => {
      adjustCasalValor(casal_id, valor_cents);
      db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents) VALUES (?,?)`).run(casal_id, valor_cents);
    });
    tx();

    res.redirect('/casais/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

router.post('/casais/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const valor = parseFloat(String(req.body.valor || '').replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);
    if (!id || valor_cents <= 0) return res.redirect('/casais/rodizio?err=Valor+inválido');

    const current = db.prepare(`SELECT casal_id, valor_cents FROM rodizio_aplicacoes WHERE id=?`).get(id);
    if (!current) return res.redirect('/casais/rodizio?err=Aplicação+não+existe');

    const diff = valor_cents - current.valor_cents;
    const tx = db.transaction(() => {
      db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=? WHERE id=?`).run(valor_cents, id);
      if (diff !== 0) adjustCasalValor(current.casal_id, diff);
    });
    tx();
    res.redirect('/casais/rodizio?msg=Valor+atualizado');
  } catch (e) { next(e); }
});

router.post('/casais/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    const current = db.prepare(`SELECT casal_id, valor_cents FROM rodizio_aplicacoes WHERE id=?`).get(req.params.id);
    if (!current) return res.redirect('/casais/rodizio?msg=Aplicação+apagada');

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(req.params.id);
      adjustCasalValor(current.casal_id, -current.valor_cents);
    });
    tx();
    res.redirect('/casais/rodizio?msg=Aplicação+apagada');
  } catch (e) { next(e); }
});

export default router;
