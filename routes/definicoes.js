// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ===================== BOOT/MIGRAÇÃO ===================== */
function ensureSettingsRow() {
  let row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO settings (id,line1,line2,primary_color,secondary_color)
      VALUES (1,?,?,?,?)
    `).run(
      'Comissão de Festas',
      'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz',
      '#1f6feb',
      '#b58900'
    );
    row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }
  return row;
}

// tabela para aplicações parciais do resto
(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
      valor_cents INTEGER NOT NULL CHECK (valor_cents >= 0)
    );
  `);
})();

/* ===================== HELPERS ===================== */
const euros = v => ((v || 0) / 100).toFixed(2);

/* ===================== RODÍZIO ===================== */
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // total dos casais
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;

    // movimentos
    const receitas = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despesas = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const patrocinadores = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;

    const saldoMovimentos = receitas - despesas + peditorios + patrocinadores;

    // lucro dos jantares ainda não lançados
    const jantaresPendentes = db.prepare(`
      SELECT SUM((COALESCE(valor_total_pago_cents,0)) - COALESCE(despesas_cents,0)) AS lucro
      FROM jantares
      WHERE id NOT IN (SELECT jantar_id FROM movimentos WHERE jantar_id IS NOT NULL)
    `).get()?.lucro ?? 0;

    const lucroProjetado = Math.max(0, jantaresPendentes);

    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // resto teórico e disponível
    const restoTeorico = Math.max(0, saldoProjetado - totalCasaCents);

    const aplicadoRestoCents = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;

    // resto disponível deve ser SEM lucro projetado
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoRestoCents);

    const casais = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY nome`).all();

    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      euros,
      casais,
      settings,
      resumo: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasaCents,
        restoTeorico,
        aplicadoRestoCents,
        restoDisponivel
      },
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

/* Guardar definições */
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoEuros = String(req.body.bloco || '').replace(',', '.');
    const blocoCents = Math.round(Number(blocoEuros) * 100);
    const inicioId = req.body.inicio_casal_id ? Number(req.body.inicio_casal_id) : null;

    db.prepare(`
      UPDATE settings
         SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
       WHERE id=1
    `).run(blocoCents, inicioId);

    res.redirect('/definicoes/rodizio?msg=Definições+guardadas');
  } catch (e) { next(e); }
});

/* Aplicar parte do resto */
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id);
    const valorTxt = String(req.body.valor || '').replace(',', '.');
    const valor_cents = Math.round(Number(valorTxt) * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    const receitas = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despesas = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const patrocinadores = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;

    const saldoMovimentos = receitas - despesas + peditorios + patrocinadores;
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;
    const aplicadoRestoCents = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoRestoCents);

    if (valor_cents > restoDisponivel) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents) VALUES (?, ?)`)
      .run(casal_id, valor_cents);

    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

/* Editar aplicação */
router.post('/definicoes/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const valorTxt = String(req.body.valor || '').replace(',', '.');
    const valor_cents = Math.round(Number(valorTxt) * 100);
    if (valor_cents < 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=? WHERE id=?`).run(valor_cents, id);
    res.redirect('/definicoes/rodizio?msg=Aplicação+atualizada');
  } catch (e) { next(e); }
});

/* Apagar aplicação */
router.post('/definicoes/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(req.params.id);
    res.redirect('/definicoes/rodizio?msg=Aplicação+apagada');
  } catch (e) { next(e); }
});

export default router;

