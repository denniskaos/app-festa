// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

const KEYS = [
  { key: 'line1', label:'Linha 1 (nome)', type:'text' },
  { key: 'line2', label:'Linha 2 (subtítulo)', type:'text' },
  { key: 'logo_path', label:'Caminho do logótipo', type:'text' },
  { key: 'primary_color', label:'Cor primária', type:'color' },
  { key: 'secondary_color', label:'Cor secundária', type:'color' },
  { key: 'title', label:'Título da página', type:'text' },
  { key: 'sub_title', label:'Sub-título', type:'text' },
];

/* ===================== BOOT/MIGRAÇÃO ===================== */
// linha fixa na settings
function ensureSettingsRow() {
  let row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO settings (id,line1,line2,primary_color,secondary_color)
      VALUES (1,?,?,?,?)
    `).run(
      'Comisão de Festas',
      'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz',
      '#1f6feb',
      '#b58900'
    );
    row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }
  return row;
}

// tabela para aplicações parciais do resto
(function ensureRodizioTables(){
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT NOT NULL DEFAULT (date('now')),
        casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
        valor_cents INTEGER NOT NULL CHECK (valor_cents >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_rodizio_aplicacoes_casal ON rodizio_aplicacoes(casal_id);
    `);
  } catch {}
})();

/* ===================== DEFINIÇÕES BASE ===================== */

router.get('/definicoes', requireAuth, (req, res) => {
  const row = ensureSettingsRow();
  const me = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  res.render('definicoes', {
    title:'Definições',
    user:req.session.user,
    KEYS,
    map:row,
    me,
    msg:req.query.msg||null,
    err:req.query.err||null
  });
});

router.post('/definicoes', requireAuth, (req, res) => {
  const fields = KEYS.map(k => k.key);
  const setSql = fields.map(k => `${k}=?`).join(', ');
  const values = fields.map(k => (req.body[k] ?? null));
  db.prepare(`UPDATE settings SET ${setSql} WHERE id=1`).run(...values);
  res.redirect('/definicoes?msg=Definições+guardadas');
});

router.post('/definicoes/perfil', requireAuth, (req, res) => {
  const { name, email, current_password, new_password, confirm_password } = req.body;
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?').run((name||'').trim(), (email||'').trim(), req.session.user.id);

  if (new_password || confirm_password || current_password) {
    const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.user.id);
    if (!bcrypt.compareSync(current_password || '', me.password_hash)) {
      return res.redirect('/definicoes?err=Password+atual+incorreta');
    }
    if (!new_password || new_password !== confirm_password) {
      return res.redirect('/definicoes?err=Password+nova+não+confere');
    }
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.session.user.id);
  }
  const updated = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  req.session.user = updated;
  res.redirect('/definicoes?msg=Perfil+atualizado');
});

/* ===================== RODÍZIO (com a FÓRMULA pedida) ===================== */

// helper simples de euros (para a view)
function euros(centsValue) {
  return ((centsValue || 0) / 100).toFixed(2);
}

// coluna preco_cents existe?
const HAS_PRECO_COL = (() => {
  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    return cols.includes('preco_cents');
  } catch { return false; }
})();

// receita de um jantar (considera overrides por convidado quando existirem)
function receitaJantarCents(j) {
  const base = j.valor_pessoa_cents || 0;
  if (HAS_PRECO_COL) {
    const agg = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(base, j.id);
    if (!agg || !agg.n) return (j.pessoas || 0) * base;
    return agg.s || 0;
  }
  // fallback sem coluna preco_cents
  const n = db.prepare(`SELECT COUNT(*) AS n FROM jantares_convidados WHERE jantar_id=?`).get(j.id)?.n || 0;
  return (n ? n : (j.pessoas || 0)) * base;
}

// Heurística para saber se um jantar já foi lançado aos movimentos (receita):
// 1) descr contém "(ID:<id>)", OU
// 2) tem título -> descr LIKE '%Jantar%<title>%Receita%' em categoria type='receita', OU
// 3) tem data    -> descr LIKE '%Jantar%<dt>%Receita%'   em categoria type='receita'
function isJantarLancado(j) {
  // 1) marcador por ID
  const rowById = db.prepare(`
    SELECT m.id
    FROM movimentos m
    JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='receita'
      AND m.descr LIKE ?
    LIMIT 1
  `).get(`%(ID:${j.id})%`);
  if (rowById?.id) return true;

  // 2) por título
  if (j.title && j.title.trim()) {
    const r = db.prepare(`
      SELECT m.id
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
        AND m.descr LIKE ?
      LIMIT 1
    `).get(`%Jantar%${j.title.trim()}%Receita%`);
    if (r?.id) return true;
  }

  // 3) por data
  if (j.dt && String(j.dt).trim()) {
    const r = db.prepare(`
      SELECT m.id
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
        AND m.descr LIKE ?
      LIMIT 1
    `).get(`%Jantar%${String(j.dt).trim()}%Receita%`);
    if (r?.id) return true;
  }

  return false;
}

// GET /definicoes/rodizio  (tudo calculado com a tua fórmula)
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // ---- Totais "em casa" (casais) ----
    const casais = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY id`).all();
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;

    // ---- Saldo movimentos = receitas − despesas + peditórios + patrocínios ENTREGUES ----
    const movAgg = db.prepare(`
      SELECT
        IFNULL(SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END),0) AS receitas,
        IFNULL(SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END),0)  AS despesas
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
    `).get();
    const movReceitas  = movAgg?.receitas || 0;
    const movDespesas  = movAgg?.despesas || 0;
    const pedSum       = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s || 0;
    const patEntregue  = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s || 0;

    const saldoMovimentosCents = (movReceitas - movDespesas) + pedSum + patEntregue;

    // ---- Lucro projetado dos jantares pendentes ----
    const jantares = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

    let lucroProjetadoPendentesCents = 0;
    for (const j of jantares) {
      const lancado = isJantarLancado(j);
      if (!lancado) {
        const receita = receitaJantarCents(j);
        const lucro   = receita - (j.despesas_cents || 0);
        lucroProjetadoPendentesCents += lucro;
      }
    }

    // ---- Saldo projetado ----
    const saldoProjetadoCents = saldoMovimentosCents + lucroProjetadoPendentesCents;

    // ---- Resto teórico / disponível (com aplicações parciais) ----
    const restoTeoricoCents = Math.max(0, saldoProjetadoCents - (totalCasaCents || 0));
    const aplicadoRestoCents = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s || 0;
    const restoDisponivelCents = Math.max(0, restoTeoricoCents - aplicadoRestoCents);

    // (mantemos também blocos do rodízio na settings, caso a tua view ainda mostre)
    const blocoCents = Number(settings.rodizio_bloco_cents ?? 500000);
    const blocosCompletos = blocoCents > 0 ? Math.floor((totalCasaCents || 0) / blocoCents) : 0;
    const blocksAplicados = Number(settings.rodizio_blocks_aplicados ?? 0);

    // histórico das aplicações
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      settings,
      casais,
      euros,
      resumo: {
        // breakdown do saldo movimentos
        movReceitas,
        movDespesas,
        pedSum,
        patEntregue,
        saldoMovimentosCents,

        // jantares
        lucroProjetadoPendentesCents,
        saldoProjetadoCents,

        // casais
        totalCasaCents,

        // resto (tua fórmula)
        restoTeoricoCents,
        aplicadoRestoCents,
        restoDisponivelCents,

        // legacy/compat (se a view usar)
        blocoCents,
        blocosCompletos,
        blocksAplicados
      },
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio  (ainda guarda bloco/início, para compatibilidade com a tua view)
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoEuros = String(req.body.bloco ?? '').trim();
    const blocoCents = Math.round(Number(blocoEuros.replace(',', '.')) * 100) || 0;
    const inicioId   = req.body.inicio_casal_id ? Number(req.body.inicio_casal_id) : null;

    ensureSettingsRow();
    db.prepare(`
      UPDATE settings
         SET rodizio_bloco_cents = ?,
             rodizio_inicio_casal_id = ?
       WHERE id=1
    `).run(blocoCents, inicioId);

    res.redirect('/definicoes/rodizio?msg=Definições+de+rodízio+guardadas');
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio/aplicar  (aplicar parte do resto a um casal)
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0) || null;
    const valorTxt = String(req.body.valor || '').trim().replace(/\s/g,'').replace('.', '').replace(',', '.');
    const valor_cents = Math.round((Number(valorTxt) || 0) * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // recalcular resto disponível (para não permitir passar do limite)
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s || 0;

    const movAgg = db.prepare(`
      SELECT
        IFNULL(SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END),0) AS receitas,
        IFNULL(SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END),0)  AS despesas
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
    `).get();
    const movReceitas  = movAgg?.receitas || 0;
    const movDespesas  = movAgg?.despesas || 0;
    const pedSum       = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s || 0;
    const patEntregue  = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s || 0;
    const saldoMovimentosCents = (movReceitas - movDespesas) + pedSum + patEntregue;

    const jantares = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents
      FROM jantares
    `).all();
    let lucroProjetadoPendentesCents = 0;
    for (const j of jantares) {
      if (!isJantarLancado(j)) {
        const receita = receitaJantarCents(j);
        const lucro   = receita - (j.despesas_cents || 0);
        lucroProjetadoPendentesCents += lucro;
      }
    }

    const saldoProjetadoCents = saldoMovimentosCents + lucroProjetadoPendentesCents;
    const restoTeoricoCents   = Math.max(0, saldoProjetadoCents - totalCasaCents);
    const aplicadoRestoCents  = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s || 0;
    const restoDisponivelCents= Math.max(0, restoTeoricoCents - aplicadoRestoCents);

    if (valor_cents > restoDisponivelCents) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`
      INSERT INTO rodizio_aplicacoes (casal_id, valor_cents)
      VALUES (?, ?)
    `).run(casal_id, valor_cents);

    return res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

export default router;
