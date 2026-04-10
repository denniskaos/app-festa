// routes/dashboard.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

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

  // Saldo final = Patrocínios + Peditórios + Saldo dos Movimentos
  const saldoFinal = totalPatrocinadores + totalPeditorios + saldoMov;
<<<<<<< codex/identify-application-improvement-areas-pqdku3
  const desvioOrcamento = saldoFinal - orcamentoTotal;
  const execucaoOrcamentoPct = orcamentoTotal > 0 ? (sumDesp / orcamentoTotal) * 100 : 0;
=======
  const caixaTotal = saldoFinal + totalCasa;
  const desvioOrcamento = saldoFinal - orcamentoTotal;
  const execucaoOrcamentoPct = orcamentoTotal > 0 ? (sumDesp / orcamentoTotal) * 100 : 0;

  const topDesvios = db
    .prepare(
      `
    SELECT
      c.name,
      c.type,
      COALESCE(c.planned_cents, 0) AS planned_cents,
      COALESCE(SUM(m.valor_cents), 0) AS actual_cents,
      COALESCE(SUM(m.valor_cents), 0) - COALESCE(c.planned_cents, 0) AS delta_cents
    FROM categorias c
    LEFT JOIN movimentos m ON m.categoria_id = c.id
    GROUP BY c.id, c.name, c.type, c.planned_cents
    ORDER BY ABS(delta_cents) DESC, c.name
    LIMIT 8
  `
    )
    .all()
    .map((r) => ({
      ...r,
      pct: r.planned_cents > 0 ? (r.actual_cents / r.planned_cents) * 100 : null,
    }));
>>>>>>> main

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
    saldoFinal,
<<<<<<< codex/identify-application-improvement-areas-pqdku3
    desvioOrcamento,
    execucaoOrcamentoPct,
=======
    caixaTotal,
    desvioOrcamento,
    execucaoOrcamentoPct,
    topDesvios,
>>>>>>> main
  });
});

export default router;
