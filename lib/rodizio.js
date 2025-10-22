import db from '../db.js';
import { ensureSettingsRow } from './settings.js';

export function casaisTargetCents(settings) {
  const raw = Number(settings?.rodizio_bloco_cents);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 500000;
}

function casalValorColumn() {
  try {
    const cols = db.prepare("PRAGMA table_info(casais)").all().map(c => c.name);
    if (cols.includes('valor_casa_cents')) return 'valor_casa_cents';
    if (cols.includes('cash_cents')) return 'cash_cents';
    if (cols.includes('valor_cents')) return 'valor_cents';
  } catch {
    /* ignore */
  }
  return null;
}

export function adjustCasalValor(casalId, deltaCents) {
  if (!casalId || !Number.isFinite(deltaCents) || deltaCents === 0) return;
  const column = casalValorColumn();
  if (!column) return;
  db.prepare(
    `UPDATE casais
        SET ${column} = MAX(0, COALESCE(${column},0) + ?)
      WHERE id=?`
  ).run(deltaCents, casalId);
}

function sumOr0(query) {
  try {
    const row = db.prepare(query).get();
    const value = Number(row?.s ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function loadRodizioResumo() {
  const settings = ensureSettingsRow();

  const recMov = sumOr0(`
    SELECT IFNULL(SUM(m.valor_cents),0) AS s
    FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='receita'
  `);
  const despMov = sumOr0(`
    SELECT IFNULL(SUM(m.valor_cents),0) AS s
    FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='despesa'
  `);
  const ped = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`);
  const pat = sumOr0(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);

  const lucroProjetado = sumOr0(`
    SELECT IFNULL(SUM((pessoas*valor_pessoa_cents)-despesas_cents),0) AS s
    FROM jantares WHERE lancado IS NULL OR lancado=0
  `);

  const saldoMovimentos = recMov - despMov + ped + pat;
  const casaisTarget = casaisTargetCents(settings);
  const saldoProjetado = Math.max(0, lucroProjetado);

  const aplicadoResto = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
  const valorCol = casalValorColumn();
  const totalCasais = valorCol
    ? sumOr0(`SELECT IFNULL(SUM(${valorCol}),0) AS s FROM casais`)
    : 0;
  const faltamParaCasais = Math.max(0, casaisTarget - totalCasais);
  const restoTeoricoBruto = Math.max(0, saldoProjetado - faltamParaCasais);
  const restoTeorico = Math.max(0, restoTeoricoBruto - aplicadoResto);
  const restoDisponivel = Math.max(0, saldoMovimentos - totalCasais);

  return {
    settings,
    saldoMovimentos,
    lucroProjetado,
    saldoProjetado,
    casaisTarget,
    aplicadoResto,
    totalCasais,
    restoTeorico,
    restoDisponivel,
  };
}
