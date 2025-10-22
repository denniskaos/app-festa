// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// helper de euros
function euros(cents) {
  return ((cents || 0) / 100).toFixed(2);
}

/* ===================== MIGRAÇÃO ===================== */
(function ensureRodizioTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
      valor_cents INTEGER NOT NULL CHECK(valor_cents>=0)
    );
  `);
})();

/* ===================== RODÍZIO ===================== */
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = db.prepare(`SELECT * FROM settings WHERE id=1`).get() || {};

    // Totais básicos
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;

    const recMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const ped = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const pat = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;

    // Lucro projetado de jantares não lançados
    const lucroProjetado = db.prepare(`
      SELECT IFNULL(SUM((pessoas*valor_pessoa_cents)-despesas_cents),0) AS s
      FROM jantares WHERE lancado IS NULL OR lancado=0
    `).get().s;

    // Saldo movimentos e saldo projetado
    const saldoMovimentos = recMov - despMov + ped + pat;
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // Resto teórico e disponível
    const restoTeorico = Math.max(0, saldoProjetado - totalCasaCents);
    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoResto);

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
      resumo: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasaCents,
        restoTeorico,
        aplicadoResto,
        restoDisponivel
      },
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// Guardar parâmetros
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = Math.round(parseFloat(req.body.bloco.replace(',', '.')) * 100) || 0;
    const inicioId = Number(req.body.inicio_casal_id) || null;
    db.prepare(`
      UPDATE settings
      SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
      WHERE id=1
    `).run(blocoCents, inicioId);
    res.redirect('/definicoes/rodizio?msg=Definições+atualizadas');
  } catch (e) { next(e); }
});

// Aplicar resto
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id);
    const valor = parseFloat(req.body.valor.replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcular o disponível
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;
    const recMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const ped = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const pat = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;
    const saldoMovimentos = recMov - despMov + ped + pat;
    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoResto);

    // ⚙️ Permitir pequenas diferenças de cêntimos (até 5 cêntimos de tolerância)
    if (valor_cents > restoDisponivel + 5) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents) VALUES (?,?)`)
      .run(casal_id, valor_cents);

    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

// Editar valor aplicado
router.post('/definicoes/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const valor = parseFloat(req.body.valor.replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);
    if (!id || valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');
    db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=? WHERE id=?`).run(valor_cents, id);
    res.redirect('/definicoes/rodizio?msg=Valor+atualizado');
  } catch (e) { next(e); }
});

// Apagar valor aplicado
router.post('/definicoes/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(req.params.id);
    res.redirect('/definicoes/rodizio?msg=Aplicação+apagada');
  } catch (e) { next(e); }
});

export default router;
