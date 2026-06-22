import { Router } from 'express';
import db, { euros } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

function parseEuroValue(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  if (!normalized) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function listLeiloes() {
  return db.prepare(`
    SELECT numero, COALESCE(dt, '') AS dt,
           COALESCE(valor_recebido_cents, 0) AS valor_recebido_cents
    FROM leiloes
    ORDER BY numero
  `).all();
}

function renderLeiloes(res, { status = 200, error = null, msg = null } = {}) {
  const leiloes = listLeiloes();
  const total = leiloes.reduce((sum, row) => sum + row.valor_recebido_cents, 0);
  return res.status(status).render('leiloes', {
    title: 'Leilões', leiloes, total, euros, error, msg,
  });
}

router.get('/leiloes', requireAuth, (req, res) => {
  renderLeiloes(res, { msg: cleanText(req.query.msg, 240) || null });
});

router.post('/leiloes/:numero', requireAuth, (req, res, next) => {
  try {
    const numero = Number(req.params.numero);
    const dt = cleanText(req.body.dt, 10);
    const valorRecebido = parseEuroValue(req.body.valor_recebido);

    if (!Number.isInteger(numero) || numero < 1 || numero > 4) {
      return res.status(404).type('text').send('Leilão não encontrado.');
    }
    if (!validDate(dt) || valorRecebido === null) {
      return renderLeiloes(res, {
        status: 400,
        error: 'Indica uma data válida e um valor igual ou superior a zero.',
      });
    }

    db.prepare(`
      UPDATE leiloes
      SET dt = ?, valor_recebido_cents = ?
      WHERE numero = ?
    `).run(dt || null, valorRecebido, numero);

    return res.redirect(`/leiloes?msg=${encodeURIComponent(`Leilão ${numero} atualizado.`)}`);
  } catch (error) {
    return next(error);
  }
});

function listVendasLugares() {
  return db.prepare(`
    SELECT id, nome, lugar, valor_total_cents, valor_pago_cents,
           MAX(valor_total_cents - valor_pago_cents, 0) AS valor_em_falta_cents
    FROM vendas_lugares
    ORDER BY lugar COLLATE NOCASE, id
  `).all();
}

function vendasSummary(rows) {
  return rows.reduce((totals, row) => ({
    total: totals.total + row.valor_total_cents,
    pago: totals.pago + row.valor_pago_cents,
    emFalta: totals.emFalta + row.valor_em_falta_cents,
  }), { total: 0, pago: 0, emFalta: 0 });
}

function renderLugares(res, {
  status = 200, error = null, msg = null, values = {},
} = {}) {
  const vendas = listVendasLugares();
  return res.status(status).render('lugares', {
    title: 'Venda de lugares', vendas, totals: vendasSummary(vendas),
    euros, error, msg, values,
  });
}

function parseVenda(body) {
  const nome = cleanText(body.nome);
  const lugar = cleanText(body.lugar, 80);
  const valorTotal = parseEuroValue(body.valor_total);
  const valorPago = parseEuroValue(body.valor_pago);

  if (!nome || !lugar) {
    return { error: 'O nome do comprador e o lugar são obrigatórios.' };
  }
  if (valorTotal === null || valorPago === null) {
    return { error: 'Os valores têm de ser iguais ou superiores a zero.' };
  }
  if (valorPago > valorTotal) {
    return { error: 'O valor pago não pode ser superior ao valor total da venda.' };
  }
  return { nome, lugar, valorTotal, valorPago };
}

router.get('/lugares', requireAuth, (req, res) => {
  renderLugares(res, { msg: cleanText(req.query.msg, 240) || null });
});

router.post('/lugares', requireAuth, (req, res, next) => {
  const venda = parseVenda(req.body);
  if (venda.error) {
    return renderLugares(res, { status: 400, error: venda.error, values: req.body });
  }

  try {
    db.prepare(`
      INSERT INTO vendas_lugares (nome, lugar, valor_total_cents, valor_pago_cents)
      VALUES (?, ?, ?, ?)
    `).run(venda.nome, venda.lugar, venda.valorTotal, venda.valorPago);
    return res.redirect('/lugares?msg=' + encodeURIComponent('Venda registada.'));
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return renderLugares(res, {
        status: 409,
        error: 'Esse lugar já está vendido. Edita o registo existente ou escolhe outro lugar.',
        values: req.body,
      });
    }
    return next(error);
  }
});

router.get('/lugares/:id/edit', requireAuth, (req, res, next) => {
  try {
    const venda = db.prepare(`
      SELECT id, nome, lugar, valor_total_cents, valor_pago_cents
      FROM vendas_lugares WHERE id = ?
    `).get(req.params.id);
    if (!venda) return res.status(404).type('text').send('Venda não encontrada.');
    return res.render('lugares_edit', {
      title: 'Editar venda de lugar', venda, euros, error: null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/lugares/:id', requireAuth, (req, res, next) => {
  const venda = parseVenda(req.body);
  if (venda.error) {
    return res.status(400).render('lugares_edit', {
      title: 'Editar venda de lugar',
      venda: {
        id: req.params.id,
        nome: req.body.nome,
        lugar: req.body.lugar,
        valor_total_cents: parseEuroValue(req.body.valor_total) || 0,
        valor_pago_cents: parseEuroValue(req.body.valor_pago) || 0,
      },
      euros,
      error: venda.error,
    });
  }

  try {
    const result = db.prepare(`
      UPDATE vendas_lugares
      SET nome = ?, lugar = ?, valor_total_cents = ?, valor_pago_cents = ?
      WHERE id = ?
    `).run(venda.nome, venda.lugar, venda.valorTotal, venda.valorPago, req.params.id);
    if (!result.changes) return res.status(404).type('text').send('Venda não encontrada.');
    return res.redirect('/lugares?msg=' + encodeURIComponent('Venda atualizada.'));
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).render('lugares_edit', {
        title: 'Editar venda de lugar',
        venda: {
          id: req.params.id,
          nome: venda.nome,
          lugar: venda.lugar,
          valor_total_cents: venda.valorTotal,
          valor_pago_cents: venda.valorPago,
        },
        euros,
        error: 'Esse lugar já está associado a outra venda.',
      });
    }
    return next(error);
  }
});

router.post('/lugares/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare('DELETE FROM vendas_lugares WHERE id = ?').run(req.params.id);
    return res.redirect('/lugares?msg=' + encodeURIComponent('Venda apagada.'));
  } catch (error) {
    return next(error);
  }
});

export default router;
