// routes/dashboard.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { countPendingPasswordResetRequests } from '../lib/passwordReset.js';

const router = Router();

function getInt(sql) {
  try {
    const row = db.prepare(sql).get();
    return (row && (row.n ?? row.total ?? 0)) || 0;
  } catch {
    return 0;
  }
}

router.get(['/dashboard', '/'], requireAuth, (req, res) => {
  // Movimentos
  const sumRec = getInt(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS n
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    WHERE c.type = 'receita'
  `);
  const sumDesp = getInt(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS n
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    WHERE c.type = 'despesa'
  `);
  const saldoMov = sumRec - sumDesp;

  // Orçamento (serviços contratados)
  const orcamentoTotal = getInt(`SELECT COALESCE(SUM(valor_cents),0) AS n FROM orcamento_servicos`);

  // Em casa (casais) — compatível com várias versões
  let totalCasa = 0;
  try {
    const cols = db.prepare("PRAGMA table_info(casais)").all().map(c => c.name);
    if (cols.includes('valor_casa_cents')) {
      totalCasa = getInt(`SELECT COALESCE(SUM(valor_casa_cents),0) AS n FROM casais`);
    } else if (cols.includes('cash_cents')) {
      totalCasa = getInt(`SELECT COALESCE(SUM(cash_cents),0) AS n FROM casais`);
    } else if (cols.includes('valor_cents')) {
      totalCasa = getInt(`SELECT COALESCE(SUM(valor_cents),0) AS n FROM casais`);
    } else {
      totalCasa = 0;
    }
  } catch { totalCasa = 0; }

  // Patrocinadores (usa valor_entregue_cents se existir; senão valor_cents)
  const totalPatrocinadores = getInt(`
    SELECT COALESCE(SUM(
      COALESCE(valor_entregue_cents,
               CASE WHEN valor_cents IS NOT NULL AND valor_cents > 0 THEN valor_cents ELSE 0 END)
    ),0) AS n
    FROM patrocinadores
  `);

  // Peditórios (usa valor_entregue_cents se existir; senão valor_cents)
  const totalPeditorios = getInt(`
    SELECT COALESCE(SUM(
      COALESCE(valor_entregue_cents,
               CASE WHEN valor_cents IS NOT NULL THEN valor_cents ELSE 0 END)
    ),0) AS n
    FROM peditorios
  `);

  // Leilões: apenas valores já recebidos
  const totalLeiloes = getInt(`
    SELECT COALESCE(SUM(valor_recebido_cents), 0) AS n
    FROM leiloes
    WHERE numero BETWEEN 1 AND 3
  `);

  // Venda de lugares: apenas o montante efetivamente recebido
  const totalLugaresPago = getInt(`
    SELECT COALESCE(SUM(valor_pago_cents), 0) AS n
    FROM vendas_lugares
  `);

  // Saldo final inclui apenas dinheiro efetivamente recebido.
  const saldoFinal = totalPatrocinadores + totalPeditorios + totalLeiloes + totalLugaresPago + saldoMov;
  // Compatibilidade com templates antigos que esperam a tabela "Top desvios".
  const topDesvios = [];
  // `var` defensivo aqui evita crash em cenários de merge acidental com redeclaração.
  var desvioOrcamento = saldoFinal - orcamentoTotal;
  var execucaoOrcamentoPct = orcamentoTotal > 0 ? (sumDesp / orcamentoTotal) * 100 : 0;
  const pendingPasswordResetCount = req.session.user?.role === 'admin'
    ? countPendingPasswordResetRequests()
    : 0;

  res.render('dashboard', {
    title: 'Painel',
    user: req.session.user,
    sumRec,
    sumDesp,
    saldoMov,
    orcamentoTotal,
    totalCasa,
    totalPatrocinadores,
    totalPeditorios,
    totalLeiloes,
    totalLugaresPago,
    saldoFinal,
    desvioOrcamento,
    execucaoOrcamentoPct,
    pendingPasswordResetCount,
    topDesvios,
  });
});

export default router;
