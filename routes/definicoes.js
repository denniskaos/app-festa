// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ===================== MIGRAÇÕES DEFENSIVAS ===================== */
// Garante colunas adicionais em settings (se ainda não existirem)
(function ensureSettingsColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info('settings')`).all().map(c => c.name);
    const addIfMissing = (name, sql) => { if (!cols.includes(name)) { try { db.exec(sql); } catch {} } };
    addIfMissing('rodizio_bloco_cents',        `ALTER TABLE settings ADD COLUMN rodizio_bloco_cents INTEGER`);
    addIfMissing('rodizio_inicio_casal_id',    `ALTER TABLE settings ADD COLUMN rodizio_inicio_casal_id INTEGER`);
    addIfMissing('rodizio_blocks_aplicados',   `ALTER TABLE settings ADD COLUMN rodizio_blocks_aplicados INTEGER NOT NULL DEFAULT 0`);
  } catch {}
})();

// Tabela para registar aplicações parciais do resto
(function ensureRodizioTables() {
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

/* ===================== HELPERS ===================== */

// linha fixa na settings (id=1)
function ensureSettingsRow() {
  let row = db.prepare(`SELECT * FROM settings WHERE id=1`).get();
  if (!row) {
    db.prepare(`
      INSERT INTO settings (id, line1, line2, primary_color, secondary_color, rodizio_bloco_cents, rodizio_blocks_aplicados)
      VALUES (1, 'Comisão de Festas', 'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz', '#1f6feb', '#b58900', 500000, 0)
    `).run();
    row = db.prepare(`SELECT * FROM settings WHERE id=1`).get();
  }
  return row;
}

const KEYS = [
  { key: 'line1',          label:'Linha 1 (nome)',         type:'text'  },
  { key: 'line2',          label:'Linha 2 (subtítulo)',    type:'text'  },
  { key: 'logo_path',      label:'Caminho do logótipo',    type:'text'  },
  { key: 'primary_color',  label:'Cor primária',           type:'color' },
  { key: 'secondary_color',label:'Cor secundária',         type:'color' },
  { key: 'title',          label:'Título da página',       type:'text'  },
  { key: 'sub_title',      label:'Sub-título',             type:'text'  },
];

// soma segura (0 se tabela/coluna não existir)
function sumOr0(sql, params = []) {
  try { return Number(db.prepare(sql).get(...params)?.s || 0); } catch { return 0; }
}

// parse “euros” (string) -> cents (int), aceita vírgula/ponto
function parseEurosToCents(v) {
  const txt = String(v ?? '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(txt);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// formata cents -> "1234.56"
function euros(centsValue) {
  return ((Number(centsValue || 0)) / 100).toFixed(2);
}

// etiqueta do jantar para casar com o descr dos movimentos
function etiquetaJantar(j) {
  const label = (j.title && j.title.trim()) ? j.title.trim() : (j.dt || `Jantar #${j.id}`);
  return label;
}

// jantar foi lançado? (procura um movimento de receita com descr "Jantar: <etiqueta> — Receita")
function jantarLancado(j) {
  const etiqueta = etiquetaJantar(j);
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    WHERE c.type='receita'
      AND c.name='Jantares'
      AND m.descr LIKE ?
    LIMIT 1
  `).get(`%Jantar:%${etiqueta}%Receita%`);
  return !!row?.ok;
}

// despesas reais do jantar (tabela detalhada, senão fallback à coluna agregada)
function despesasDoJantarCents(jid) {
  const s = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM jantares_despesas WHERE jantar_id=?`, [jid]);
  if (s > 0) return s;
  return sumOr0(`SELECT COALESCE(despesas_cents,0) AS s FROM jantares WHERE id=?`, [jid]);
}

// receita efetiva do jantar para lançamento/projeção: soma dos pagos dos PRESENTES
function receitaEfetivaJantarCents(jid) {
  return sumOr0(`
    SELECT COALESCE(SUM(pago_cents),0) AS s
    FROM jantares_convidados
    WHERE jantar_id=? AND presenca=1
  `, [jid]);
}

/* ===================== PÁGINA DEFINIÇÕES ===================== */

router.get('/definicoes', requireAuth, (req, res) => {
  const row = ensureSettingsRow();
  const me = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  res.render('definicoes', {
    title: 'Definições',
    user: req.session.user,
    KEYS,
    map: row,
    me,
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

router.post('/definicoes', requireAuth, (req, res) => {
  ensureSettingsRow();
  const fields = KEYS.map(k => k.key);
  const setSql = fields.map(k => `${k}=?`).join(', ');
  const values = fields.map(k => (req.body[k] ?? null));
  db.prepare(`UPDATE settings SET ${setSql} WHERE id=1`).run(...values);
  res.redirect('/definicoes?msg=Definições+guardadas');
});

router.post('/definicoes/perfil', requireAuth, (req, res) => {
  const { name, email, current_password, new_password, confirm_password } = req.body;
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?')
    .run((name || '').trim(), (email || '').trim(), req.session.user.id);

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

/* ===================== RODÍZIO ===================== */

// GET /definicoes/rodizio — mostra saldos e formulário
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();
    const casais = db.prepare(`SELECT id, nome, COALESCE(valor_casa_cents,0) AS valor_casa_cents FROM casais ORDER BY id`).all();

    // 1) SALDO MOVIMENTOS (já em caixa)
    const receitasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `);
    const despesasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `);
    const peditorios = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
    const patrocEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = receitasMov - despesasMov + peditorios + patrocEnt;

    // 2) LUCRO PROJETADO: apenas jantares AINDA NÃO lançados
    const jantares = db.prepare(`SELECT id, dt, title FROM jantares ORDER BY id`).all();
    let lucroProjetado = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue; // já lançado → não entra no projetado
      const rec = receitaEfetivaJantarCents(j.id);
      const desp = despesasDoJantarCents(j.id);
      lucroProjetado += (rec - desp);
    }

    // 3) SALDO PROJETADO (informativo)
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // 4) TOTAL EM CASAIS
    const totalCasaCents = sumOr0(`SELECT COALESCE(SUM(valor_casa_cents),0) AS s FROM casais`);

    // 5) RESTOS
    const aplicadoRestoCents = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);

    // Resto teórico (inclui projetado)
    const restoTeorico = Math.max(0, saldoProjetado - totalCasaCents);

    // Resto disponível (apenas dinheiro real já em caixa)
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoRestoCents);

    // Histórico
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome, a.casal_id
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

// POST /definicoes/rodizio — guardar bloco e início
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = parseEurosToCents(req.body.bloco);
    const inicioId = req.body.inicio_casal_id ? Number(req.body.inicio_casal_id) : null;
    ensureSettingsRow();
    db.prepare(`
      UPDATE settings
         SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
       WHERE id=1
    `).run(blocoCents, inicioId);
    res.redirect('/definicoes/rodizio?msg=Definições+guardadas');
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio/aplicar — cria aplicação (valida cêntimos e limite)
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0) || null;
    const valor_cents = parseEurosToCents(req.body.valor);
    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcula limite de resto disponível (baseado em dinheiro real em caixa)
    const receitasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `);
    const despesasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `);
    const peditorios = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
    const patrocEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = receitasMov - despesasMov + peditorios + patrocEnt;
    const totalCasaCents  = sumOr0(`SELECT COALESCE(SUM(valor_casa_cents),0) AS s FROM casais`);
    const aplicadoRestoCents = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents - aplicadoRestoCents);

    if (valor_cents > restoDisponivel) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents) VALUES (?,?)`).run(casal_id, valor_cents);
    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio/edit/:id — editar valor (mantendo o limite)
router.post('/definicoes/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const novo_cents = parseEurosToCents(req.body.valor);
    const row = db.prepare(`SELECT valor_cents FROM rodizio_aplicacoes WHERE id=?`).get(id);
    if (!row) return res.redirect('/definicoes/rodizio?err=Registo+inexistente');
    if (novo_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Limite: (saldoMov - totalCasa) ≥ (aplicado_total - antigo + novo)
    const receitasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `);
    const despesasMov = sumOr0(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `);
    const peditorios = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
    const patrocEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = receitasMov - despesasMov + peditorios + patrocEnt;

    const totalCasaCents  = sumOr0(`SELECT COALESCE(SUM(valor_casa_cents),0) AS s FROM casais`);
    const aplicadoTotal   = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
    const aplicadoAposEdicao = aplicadoTotal - row.valor_cents + novo_cents;
    const maxAplicavel = Math.max(0, saldoMovimentos - totalCasaCents);

    if (aplicadoAposEdicao > maxAplicavel) {
      return res.redirect('/definicoes/rodizio?err=Edição+excede+o+resto+disponível');
    }

    db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=? WHERE id=?`).run(novo_cents, id);
    res.redirect('/definicoes/rodizio?msg=Aplicação+atualizada');
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio/delete/:id — apagar registo
router.post('/definicoes/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(Number(req.params.id));
    res.redirect('/definicoes/rodizio?msg=Aplicação+apagada');
  } catch (e) { next(e); }
});

export default router;
