// routes/definicoes.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// helper
function euros(cents){ return ((cents||0)/100).toFixed(2); }

/* ===================== MIGRAÇÃO / RECONCILIAÇÃO ===================== */
(function ensureRodizioTables(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
      valor_cents INTEGER NOT NULL CHECK(valor_cents>=0),
      refletido INTEGER NOT NULL DEFAULT 0
    );
  `);
  // garantir a coluna refletido (para bases antigas)
  try {
    const cols = db.prepare(`PRAGMA table_info('rodizio_aplicacoes')`).all().map(c=>c.name);
    if (!cols.includes('refletido')) {
      db.exec(`ALTER TABLE rodizio_aplicacoes ADD COLUMN refletido INTEGER NOT NULL DEFAULT 0`);
    }
  } catch {}

  // reconciliar aplicações antigas: somar ao casal e marcar refletido=1
  const pendentes = db.prepare(`
    SELECT id, casal_id, valor_cents
    FROM rodizio_aplicacoes
    WHERE refletido=0
  `).all();

  if (pendentes.length) {
    const tx = db.transaction(() => {
      for (const a of pendentes) {
        db.prepare(`UPDATE casais SET valor_casa_cents = COALESCE(valor_casa_cents,0) + ? WHERE id=?`)
          .run(a.valor_cents, a.casal_id);
        db.prepare(`UPDATE rodizio_aplicacoes SET refletido=1 WHERE id=?`).run(a.id);
      }
    });
    tx();
  }
})();

/* ===================== RODÍZIO ===================== */
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = db.prepare(`SELECT * FROM settings WHERE id=1`).get() || {};

    // Totais “em casais” (já inclui aplicações refletidas)
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;

    // Movimentos reais
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

    // Jantares pendentes (não lançados em movimentos)
    const lucroProjetado = db.prepare(`
      SELECT IFNULL(SUM((pessoas*valor_pessoa_cents)-despesas_cents),0) AS s
      FROM jantares
      WHERE lancado IS NULL OR lancado=0
    `).get().s;

    // Saldo “real” dos movimentos
    const saldoMovimentos = recMov - despMov + ped + pat;

    // Saldo projetado = igual ao real quando não há pendentes (apenas informativo)
    const saldoProjetado = (lucroProjetado > 0) ? (saldoMovimentos + lucroProjetado) : saldoMovimentos;

    // Resto teórico (com base no real; o projetado é apenas informativo)
    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const restoTeorico   = Math.max(0, saldoMovimentos - totalCasaCents);
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoResto);

    const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY nome COLLATE NOCASE`).all();

    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, a.refletido, c.nome AS casal_nome, a.casal_id
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

/* Guardar parâmetros do rodízio (bloco + 1º casal) */
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = Math.round(parseFloat(String(req.body.bloco||'0').replace(',', '.')) * 100) || 0;
    const inicioId = req.body.inicio_casal_id ? Number(req.body.inicio_casal_id) : null;
    db.prepare(`
      UPDATE settings
      SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
      WHERE id=1
    `).run(blocoCents, inicioId);
    res.redirect('/definicoes/rodizio?msg=Definições+atualizadas');
  } catch (e) { next(e); }
});

/* Aplicar parte do resto a um casal (👍 atualiza o casal) */
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0);
    const valor = parseFloat(String(req.body.valor||'').replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);

    if (!casal_id)   return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcular disponível (base real, sem projetado)
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

    // tolerância 5 cêntimos
    if (valor_cents > restoDisponivel + 5) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents, refletido)
                  VALUES (?,?,1)`).run(casal_id, valor_cents);
      db.prepare(`UPDATE casais SET valor_casa_cents = COALESCE(valor_casa_cents,0) + ? WHERE id=?`)
        .run(valor_cents, casal_id);
    });
    tx();

    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

/* Editar aplicação (👍 ajusta o casal pelo delta) */
router.post('/definicoes/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const novo = Math.round((parseFloat(String(req.body.valor||'').replace(',', '.')) || 0) * 100);
    if (!id || novo <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    const row = db.prepare(`SELECT id, casal_id, valor_cents, refletido FROM rodizio_aplicacoes WHERE id=?`).get(id);
    if (!row) return res.redirect('/definicoes/rodizio?err=Registo+inexistente');

    const delta = novo - row.valor_cents;

    const tx = db.transaction(() => {
      db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=?, refletido=1 WHERE id=?`).run(novo, id);
      // ajustar casal apenas se já estava refletido (todas as novas estão)
      if (delta !== 0) {
        db.prepare(`UPDATE casais SET valor_casa_cents = COALESCE(valor_casa_cents,0) + ? WHERE id=?`)
          .run(delta, row.casal_id);
      }
    });
    tx();

    res.redirect('/definicoes/rodizio?msg=Valor+atualizado');
  } catch (e) { next(e); }
});

/* Apagar aplicação (👍 reverte no casal) */
router.post('/definicoes/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT id, casal_id, valor_cents, refletido FROM rodizio_aplicacoes WHERE id=?`).get(id);
    if (!row) return res.redirect('/definicoes/rodizio?err=Registo+inexistente');

    const tx = db.transaction(() => {
      if (row.refletido) {
        db.prepare(`UPDATE casais SET valor_casa_cents = COALESCE(valor_casa_cents,0) - ? WHERE id=?`)
          .run(row.valor_cents, row.casal_id);
      }
      db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(id);
    });
    tx();

    res.redirect('/definicoes/rodizio?msg=Aplicação+apagada');
  } catch (e) { next(e); }
});

export default router;
