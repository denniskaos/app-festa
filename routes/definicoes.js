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
      'Comissão de Festas',
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

/* ===================== RODÍZIO ===================== */
const euros = (c) => ((c || 0) / 100).toFixed(2);

// etiqueta para procurar movimentos do jantar
function etiquetaJantar(j) {
  return (j.title && j.title.trim()) ? j.title.trim() : (j.dt || `Jantar #${j.id}`);
}

// verifica se já há movimentos associados a este jantar
function jantarLancado(j) {
  const etiqueta = `Jantar — ${etiquetaJantar(j)}`;
  const hit = db.prepare(`SELECT 1 FROM movimentos WHERE descr LIKE ? LIMIT 1`).get(`${etiqueta}%`);
  return !!hit;
}

// total pago por jantar (o que interessa para o rodízio)
function totalPagoJantarCents(jid) {
  return db.prepare(`
    SELECT IFNULL(SUM(pago_cents),0) AS s
    FROM jantares_convidados WHERE jantar_id=?
  `).get(jid).s;
}

// total de despesas do jantar (linhas lançadas no módulo Jantares)
function despesasJantarCents(jid) {
  return db.prepare(`
    SELECT IFNULL(SUM(valor_cents),0) AS s
    FROM jantares_despesas WHERE jantar_id=?
  `).get(jid).s;
}

// GET /definicoes/rodizio
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // Casais (para a dropdown)
    const casais = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY id`).all();

    // "Em casais"
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;

    // Movimentos (receitas, despesas)
    const mov = db.prepare(`
      SELECT
        IFNULL(SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END),0) AS receitas,
        IFNULL(SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END),0)  AS despesas
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
    `).get();

    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const patrocinios = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;

    const saldoMovimentos = (mov.receitas || 0) - (mov.despesas || 0) + (peditorios || 0) + (patrocinios || 0);

    // Jantares pendentes -> lucro projetado baseado no TOTAL PAGO
    const jantares = db.prepare(`
      SELECT id, dt, title
      FROM jantares
      ORDER BY COALESCE(dt,'9999-99-99') DESC, id DESC
    `).all();

    let lucroProjetadoCents = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue; // só conta os não lançados
      const pagos = totalPagoJantarCents(j.id);
      const desps = despesasJantarCents(j.id);
      lucroProjetadoCents += (pagos - desps);
    }

    const saldoProjetado = saldoMovimentos + lucroProjetadoCents;

    // Resto teórico e disponível (ver explicação no chat)
    const blocoCents = Number(settings.rodizio_bloco_cents ?? 500000);

    const aplicadoRestoCents = db.prepare(`
      SELECT IFNULL(SUM(valor_cents),0) AS s
      FROM rodizio_aplicacoes
    `).get().s;

    const restoTeoricoCents    = Math.max(0, saldoProjetado - totalCasaCents);
    const restoDisponivelCents = Math.max(0, saldoMovimentos - totalCasaCents) - (aplicadoRestoCents || 0);

    // blocos completos (apenas para exibir)
    const blocosCompletos = blocoCents > 0 ? Math.floor(totalCasaCents / blocoCents) : 0;

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
        totalCasaCents,
        blocoCents,
        blocosCompletos,
        saldoMovimentos,
        lucroProjetadoCents,
        saldoProjetado,
        restoTeoricoCents,
        aplicadoRestoCents,
        restoDisponivelCents
      },
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio  (guardar tamanho do bloco e início do rodízio)
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

    // limite pelo resto disponível REAL (não inclui lucro projetado)
    const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;
    const mov = db.prepare(`
      SELECT
        IFNULL(SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END),0) AS receitas,
        IFNULL(SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END),0)  AS despesas
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
    `).get();
    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const patrocinios = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;
    const saldoMovimentos = (mov.receitas || 0) - (mov.despesas || 0) + (peditorios || 0) + (patrocinios || 0);

    const aplicadoRestoCents = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const restoDisponivelCents = Math.max(0, saldoMovimentos - totalCasaCents) - (aplicadoRestoCents || 0);

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
