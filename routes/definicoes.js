// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ===================== CONSTANTES / KEYS ===================== */
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

// tabela das aplicações parciais do resto
(function ensureRodizioTable(){
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
function euros(c) { return ((c || 0) / 100).toFixed(2); }
function sumOr0(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.s ?? 0; } catch { return 0; }
}

// saldo de movimentos: receitas − despesas + peditórios + patrocínios (entregue)
function calcSaldoMovimentos() {
  const recMov  = sumOr0(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS s
    FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='receita'
  `);
  const despMov = sumOr0(`
    SELECT COALESCE(SUM(m.valor_cents),0) AS s
    FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='despesa'
  `);
  const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
  const pat     = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
  return recMov - despMov + ped + pat;
}

// receita efectivamente paga e com presença por jantar
function receitaPagaPresencaJantar(jid) {
  return sumOr0(`
    SELECT COALESCE(SUM(pago_cents),0) AS s
    FROM jantares_convidados
    WHERE jantar_id=? AND presenca=1
  `, jid);
}

// jantar lançado? (procura qualquer movimento “receita” com descr contendo (ID:x))
function jantarLancado(jid) {
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM movimentos m
    JOIN categorias c ON c.id=m.categoria_id
    WHERE c.type='receita'
      AND m.descr LIKE ?
    LIMIT 1
  `).get(`%(ID:${jid})%`);
  return !!row?.ok;
}

// lucro projetado: só jantares NÃO lançados; usa pagos&presença − despesas do jantar
function calcLucroProjetadoPendentes() {
  const js = db.prepare(`
    SELECT id, COALESCE(despesas_cents,0) AS despesas_cents
    FROM jantares
  `).all();

  let total = 0;
  for (const j of js) {
    if (jantarLancado(j.id)) continue;
    const receita = receitaPagaPresencaJantar(j.id); // só o que está pago e com presença
    total += (receita - (j.despesas_cents || 0));
  }
  return total;
}

function calcResumoRodizio() {
  const settings = ensureSettingsRow();

  const saldoMovimentos = calcSaldoMovimentos();
  const lucroProjetado  = calcLucroProjetadoPendentes();
  const saldoProjetado  = saldoMovimentos + lucroProjetado;
  const totalCasa       = sumOr0(`SELECT COALESCE(SUM(valor_casa_cents),0) AS s FROM casais`);
  const aplicadoResto   = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);

  const restoTeorico    = Math.max(0, saldoProjetado - totalCasa);
  const restoDisponivel = Math.max(0, restoTeorico - aplicadoResto);

  return {
    settings,
    saldoMovimentos,
    lucroProjetado,
    saldoProjetado,
    totalCasa,
    aplicadoResto,
    restoTeorico,
    restoDisponivel,
  };
}

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

/* ===================== RODÍZIO (Definições) ===================== */

// GET página do rodízio (definições)
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const cards = calcResumoRodizio();

    // dados auxiliares para o formulário
    const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY id`).all();

    // histórico
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      euros,
      cards,
      casais,
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// Guardar bloco e início (se tiveres esses campos na view)
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

    res.redirect('/definicoes/rodizio?msg=Definições+guardadas');
  } catch (e) { next(e); }
});

// Aplicar parte do resto disponível a um casal
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0) || null;
    const valorTxt = String(req.body.valor || '').trim()
      .replace(/\s/g,'').replace('.', '').replace(',', '.');
    const valor_cents = Math.round((Number(valorTxt) || 0) * 100);

    if (!casal_id)       return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents<=0)  return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcula exatamente como no GET
    const cards = calcResumoRodizio();
    const disponivel = cards.restoDisponivel;

    if (valor_cents > disponivel) {
      return res.redirect(
        `/definicoes/rodizio?err=Valor+excede+o+resto+disponível+(tentado:+€+${euros(valor_cents)};+disp:+€+${euros(disponivel)})`
      );
    }

    db.prepare(`
      INSERT INTO rodizio_aplicacoes (casal_id, valor_cents)
      VALUES (?,?)
    `).run(casal_id, valor_cents);

    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

export default router;
