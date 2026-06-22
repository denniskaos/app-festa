import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

function total(sql) {
  return Number(db.prepare(sql).get()?.n || 0);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanDate(value) {
  const date = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function formatDate(date) {
  if (!date) return '____ / ____ / 2026';
  const [year, month, day] = date.split('-');
  return `${day} / ${month} / ${year}`;
}

function formatMoney(cents) {
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
}

function movementGroups(type) {
  return db.prepare(`
    SELECT c.name AS descricao, COALESCE(SUM(m.valor_cents), 0) AS valor_cents
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    WHERE c.type = ?
    GROUP BY c.id, c.name
    ORDER BY c.name COLLATE NOCASE
  `).all(type).map((row) => ({
    descricao: row.descricao === 'Genérico'
      ? (type === 'receita' ? 'Outras receitas' : 'Outras despesas')
      : row.descricao,
    valor_cents: Number(row.valor_cents || 0),
  }));
}

router.get('/resumo-final', requireAuth, (req, res, next) => {
  try {
    const totalPeditorios = total(`
      SELECT COALESCE(SUM(COALESCE(valor_entregue_cents, valor_cents, 0)), 0) AS n
      FROM peditorios
    `);
    const totalPatrocinadores = total(`
      SELECT COALESCE(SUM(COALESCE(valor_entregue_cents, valor_cents, 0)), 0) AS n
      FROM patrocinadores
    `);
    const totalLeiloes = total(`
      SELECT COALESCE(SUM(valor_recebido_cents), 0) AS n
      FROM leiloes WHERE numero BETWEEN 1 AND 3
    `);
    const totalLugares = total(`
      SELECT COALESCE(SUM(valor_pago_cents), 0) AS n FROM vendas_lugares
    `);

    const receitasMovimentos = movementGroups('receita');
    const despesasMovimentos = movementGroups('despesa');
    const entradas = [
      { descricao: 'Donativos da população (Peditórios)', valor_cents: totalPeditorios },
      { descricao: 'Patrocínios', valor_cents: totalPatrocinadores },
      { descricao: 'Leilões de prendas', valor_cents: totalLeiloes },
      { descricao: 'Venda de lugares', valor_cents: totalLugares },
      ...receitasMovimentos,
    ];
    const saidas = despesasMovimentos.length
      ? despesasMovimentos
      : [{ descricao: 'Despesas registadas', valor_cents: 0 }];
    const totalEntradas = entradas.reduce((sum, row) => sum + row.valor_cents, 0);
    const totalSaidas = saidas.reduce((sum, row) => sum + row.valor_cents, 0);

    const inicio = cleanDate(req.query.inicio);
    const fim = cleanDate(req.query.fim);
    const destino = cleanText(req.query.destino, 500);
    const observacoes = cleanText(req.query.observacoes, 1200);

    return res.render('resumo_final', {
      title: 'Resumo Final de Contas',
      inicio,
      fim,
      inicioFormatado: formatDate(inicio),
      fimFormatado: formatDate(fim),
      destino,
      observacoes,
      entradas,
      saidas,
      totalEntradas,
      totalSaidas,
      saldoFinal: totalEntradas - totalSaidas,
      formatMoney,
      dataEmissao: new Intl.DateTimeFormat('pt-PT').format(new Date()),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
