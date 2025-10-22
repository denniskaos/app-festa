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

/* ===================== HELPERS ===================== */
const euros = (centsValue) => ((centsValue || 0) / 100).toFixed(2);

// soma robusta → 0 se tabela não existir
function sumOr0(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.s ?? 0; } catch { return 0; }
}

// saldo de movimentos (receitas − despesas) + peditórios + patrocínios (entregue)
function calcularSaldoMovimentos() {
  const recMov  = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                          FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                          WHERE c.type='receita'`);
  const despMov = sumOr0(`SELECT COALESCE(SUM(m.valor_cents),0) AS s
                          FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                          WHERE c.type='despesa'`);
  const ped     = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM peditorios`);
  const patEnt  = sumOr0(`SELECT COALESCE(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
  return recMov - despMov + ped + patEnt;
}

// foi lançado para movimentos? (procura marcador (ID:x) na receita do jantar)
function jantarLancado(jid) {
  const catId = db.prepare(`SELECT id FROM categorias WHERE name='Jantares' AND type='receita'`).get()?.id || null;
  if (!catId) return false;
  const ok = db.prepare(`
    SELECT 1 AS ok FROM movimentos
    WHERE categoria_id=? AND descr LIKE ?
    LIMIT 1
  `).get(catId, `%ID:${jid}%`);
  return !!ok?.ok;
}

// receita real de um jantar: soma pago_cents dos PRESENTES; se ninguém presente, 0
function receitaRealJantarCents(jid) {
  return sumOr0(`
    SELECT COALESCE(SUM(pago_cents),0) AS s
    FROM jantares_convidados
    WHERE jantar_id=? AND presenca=1
  `, jid);
}

// despesas registadas do jantar (jantares_despesas → sincronizado para jantares.despesas_cents noutros fluxos)
function despesasJantarCents(jid) {
  const s1 = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM jantares_despesas WHERE jantar_id=?`, jid);
  if (s1 > 0) return s1;
  return db.prepare(`SELECT COALESCE(despesas_cents,0) AS s FROM jantares WHERE id=?`).get(jid)?.s || 0;
}

// lucro projetado = Σ (receita real presentes − despesas) dos jantares AINDA NÃO lançados
function calcularLucroProjetadoPendentes() {
  const jids = db.prepare(`SELECT id FROM jantares ORDER BY id`).all().map(r => r.id);
  let total = 0;
  for (const jid of jids) {
    if (jantarLancado(jid)) continue;
    const rec = receitaRealJantarCents(jid);
    const desp = despesasJantarCents(jid);
    total += (rec - desp);
  }
  return total;
}

// cálculo unificado usado no GET e no POST
function calcRodizioResumo() {
  const settings = ensureSettingsRow();

  const totalCasaCents = sumOr0(`SELECT COALESCE(SUM(valor_casa_cents),0) AS s FROM casais`);
  const saldoMovimentos = calcularSaldoMovimentos();
  const lucroProjetado = calcularLucroProjetadoPendentes();
  const saldoProjetado = saldoMovimentos + lucroProjetado;

  const restoTeoricoCents = Math.max(0, saldoProjetado - totalCasaCents);

  const aplicadoRestoCents = sumOr0(`SELECT COALESCE(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
  const restoDisponivelCents = Math.max(0, restoTeoricoCents - aplicadoRestoCents);

  return {
    settings,
    totalCasaCents,
    saldoMovimentos,
    lucroProjetado,
    saldoProjetado,
    restoTeoricoCents,
    aplicadoRestoCents,
    restoDisponivelCents
  };
}

// parse “euros” em string PT → cents (aceita 1.234,56 / 1234.56 / 1234)
function parseEurosToCents(txt) {
  const s = String(txt || '').trim()
    .replace(/\s/g, '')          // remove espaços
    .replace(/\./g, '')          // remove separadores de milhar
    .replace(',', '.');          // vírgula decimal → ponto
  const n = Number(s);
  return Math.round((isFinite(n) ? n : 0) * 100);
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

// GET /definicoes/rodizio
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const casais = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY nome COLLATE NOCASE`).all();
    const resumo = calcRodizioResumo();

    // histórico
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      settings: resumo.settings,
      casais,
      euros,
      cards: {
        saldoMovimentos: resumo.saldoMovimentos,
        lucroProjetado:  resumo.lucroProjetado,
        saldoProjetado:  resumo.saldoProjetado,
        totalCasa:       resumo.totalCasaCents,
        restoTeorico:    resumo.restoTeoricoCents,
        aplicado:        resumo.aplicadoRestoCents,
        restoDisponivel: resumo.restoDisponivelCents
      },
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio  (guardar bloco/início)
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = parseEurosToCents(req.body.bloco);
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
    const valor_cents = parseEurosToCents(req.body.valor);

    if (!casal_id)     return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents<=0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // usa o MESMO cálculo do ecrã (evita divergências)
    const resumo = calcRodizioResumo();
    const disponivel = resumo.restoDisponivelCents;

    if (valor_cents > disponivel) {
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

