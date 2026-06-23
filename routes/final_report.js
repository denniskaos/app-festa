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

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function movementRows(type) {
  return db.prepare(`
    SELECT COALESCE(c.name, '') AS categoria,
           COALESCE(m.descr, '') AS descricao,
           COALESCE(m.valor_cents, 0) AS valor_cents
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    WHERE c.type = ?
    ORDER BY m.id
  `).all(type).map((row) => ({ ...row, valor_cents: Number(row.valor_cents || 0) }));
}

function rowText(row) {
  return normalize(`${row.categoria || ''} ${row.descricao || ''}`);
}

function sumByKey(rows, classify) {
  return rows.reduce((totals, row) => {
    const key = classify(row);
    if (!key) return totals;
    totals[key] = (totals[key] || 0) + row.valor_cents;
    return totals;
  }, {});
}

function receiptKey(row) {
  const text = rowText(row);
  if (text.includes('sabado') && text.includes('bombo')) return 'sabadoBombos';
  if (text.includes('rifa') || text.includes('malha')) return 'rifasMalhas';
  return 'bar';
}

function budgetKey(row) {
  const text = normalize(`${row.descricao || ''} ${row.notas || ''}`);
  if (
    text.includes('vitor marinho')
    || text.includes('fogo')
    || text.includes('artificio')
    || text.includes('pirotecnia')
  ) return 'fogoArtificio';
  if (text.includes('palco') || text.includes('gerador') || text.includes('vigilante')) return 'palco';
  if (text.includes('pedro artisom') || text.includes('artisom') || (text.includes('som') && text.includes('rua'))) return 'somRua';
  if (text.includes('som') && (text.includes('luz') || text.includes('iluminacao'))) return 'somLuz';
  if (text.includes('jantar') || text.includes('almoco') || text.includes('refeicao')) return 'jantares';
  if (text.includes('camarim')) return 'camarins';
  if (
    text.includes('estadia')
    || text.includes('alojamento')
    || text.includes('hotel')
    || text.includes('hospedagem')
    || text.includes('dormida')
  ) return 'estadias';
  if (
    text.includes('artista')
    || text.includes('nemanus')
    || text.includes('canario')
    || text.includes('saul')
  ) return 'artistas';
  if (/\bdj\b/.test(text) || text.includes('djs')) return 'djs';
  if (text.includes('bombo')) return 'bombos';
  if (text.includes('iluminacao')) return 'iluminacao';
  if (text.includes('banda')) return 'bandaMusica';
  if (text.includes('rancho')) return 'ranchos';
  if (text.includes('procissao') || text.includes('procisao')) return 'procissao';
  return null;
}

function movementExpenseKey() {
  return 'bar';
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

    const receitas = sumByKey(movementRows('receita'), receiptKey);
    const despesasMovimentos = sumByKey(movementRows('despesa'), movementExpenseKey);
    const despesasOrcamento = sumByKey(db.prepare(`
      SELECT COALESCE(descr, '') AS descricao,
             COALESCE(notas, '') AS notas,
             COALESCE(valor_cents, 0) AS valor_cents
      FROM orcamento_servicos ORDER BY id
    `).all().map((row) => ({ ...row, valor_cents: Number(row.valor_cents || 0) })), budgetKey);
    const entradas = [
      { descricao: 'Peditórios', valor_cents: totalPeditorios },
      { descricao: 'Patrocínios', valor_cents: totalPatrocinadores },
      { descricao: 'Bar', valor_cents: receitas.bar || 0 },
      { descricao: 'Sábado Bombos', valor_cents: receitas.sabadoBombos || 0 },
      { descricao: 'Rifas/Malhas', valor_cents: receitas.rifasMalhas || 0 },
      { descricao: 'Leilões de prendas', valor_cents: totalLeiloes },
      { descricao: 'Venda de lugares', valor_cents: totalLugares },
    ];
    const saidas = [
      { descricao: 'Artistas', valor_cents: despesasOrcamento.artistas || 0 },
      { descricao: 'DJs', valor_cents: despesasOrcamento.djs || 0 },
      { descricao: 'Jantares/Almoços Artistas e Som', valor_cents: despesasOrcamento.jantares || 0 },
      { descricao: 'Bombos', valor_cents: despesasOrcamento.bombos || 0 },
      { descricao: 'Som de Rua', valor_cents: despesasOrcamento.somRua || 0 },
      { descricao: 'Som + Luz', valor_cents: despesasOrcamento.somLuz || 0 },
      { descricao: 'Palco + Gerador + Vigilante', valor_cents: despesasOrcamento.palco || 0 },
      { descricao: 'Camarins', valor_cents: despesasOrcamento.camarins || 0 },
      { descricao: 'Estadias', valor_cents: despesasOrcamento.estadias || 0 },
      { descricao: 'Iluminação', valor_cents: despesasOrcamento.iluminacao || 0 },
      { descricao: 'Fogo de artifício', valor_cents: despesasOrcamento.fogoArtificio || 0 },
      { descricao: 'Banda de Música', valor_cents: despesasOrcamento.bandaMusica || 0 },
      { descricao: 'Ranchos', valor_cents: despesasOrcamento.ranchos || 0 },
      { descricao: 'Procissão', valor_cents: despesasOrcamento.procissao || 0 },
      { descricao: 'Bar', valor_cents: despesasMovimentos.bar || 0 },
    ];
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
