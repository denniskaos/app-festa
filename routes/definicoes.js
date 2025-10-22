// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* =======================================================
   CAMPOS DA PÁGINA DE DEFINIÇÕES
======================================================= */
const KEYS = [
  { key: 'line1', label: 'Linha 1 (nome)', type: 'text' },
  { key: 'line2', label: 'Linha 2 (subtítulo)', type: 'text' },
  { key: 'logo_path', label: 'Caminho do logótipo', type: 'text' },
  { key: 'primary_color', label: 'Cor primária', type: 'color' },
  { key: 'secondary_color', label: 'Cor secundária', type: 'color' },
  { key: 'title', label: 'Título da página', type: 'text' },
  { key: 'sub_title', label: 'Subtítulo da página', type: 'text' },
];

/* =======================================================
   MIGRAÇÃO RODÍZIO
======================================================= */
(function ensureRodizioTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
      valor_cents INTEGER NOT NULL CHECK(valor_cents>=0)
    );
  `);
})();

/* =======================================================
   DEFINIÇÕES GERAIS (BRANDING + PERFIL)
======================================================= */

// garante linha base
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

// GET /definicoes
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
    err: req.query.err || null,
  });
});

// POST /definicoes (branding)
router.post('/definicoes', requireAuth, (req, res) => {
  const fields = KEYS.map(k => k.key);
  const setSql = fields.map(k => `${k}=?`).join(', ');
  const values = fields.map(k => req.body[k] ?? null);
  db.prepare(`UPDATE settings SET ${setSql} WHERE id=1`).run(...values);
  res.redirect('/definicoes?msg=Definições+guardadas');
});

// POST /definicoes/perfil
router.post('/definicoes/perfil', requireAuth, (req, res) => {
  const { name, email, current_password, new_password, confirm_password } = req.body;
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?').run(
    (name || '').trim(),
    (email || '').trim(),
    req.session.user.id
  );

  if (new_password || confirm_password || current_password) {
    const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.user.id);
    if (!bcrypt.compareSync(current_password || '', me.password_hash))
      return res.redirect('/definicoes?err=Password+atual+incorreta');
    if (!new_password || new_password !== confirm_password)
      return res.redirect('/definicoes?err=Password+nova+não+confere');

    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.session.user.id);
  }

  const updated = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  req.session.user = updated;
  res.redirect('/definicoes?msg=Perfil+atualizado');
});

/* =======================================================
   RODÍZIO
======================================================= */

function euros(cents) {
  return ((cents || 0) / 100).toFixed(2);
}

// GET /definicoes/rodizio
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    const totalCasaRealCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;
    const recMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const ped = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const pat = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;

    const lucroProjetado = db.prepare(`
      SELECT IFNULL(SUM((pessoas*valor_pessoa_cents)-despesas_cents),0) AS s
      FROM jantares WHERE lancado IS NULL OR lancado=0
    `).get().s;

    const saldoMovimentos = recMov - despMov + ped + pat;
    const totalCasaCents = Number(settings.rodizio_bloco_cents ?? 500000) || totalCasaRealCents;
    const saldoProjetado = Math.max(0, lucroProjetado);

    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s;
    const faltamParaCasais = Math.max(0, totalCasaCents - saldoMovimentos);
    const restoTeoricoBruto = Math.max(0, saldoProjetado - faltamParaCasais);
    const restoTeorico = Math.max(0, restoTeoricoBruto - aplicadoResto);
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents);

    const casais = db.prepare(`SELECT id,nome FROM casais ORDER BY nome COLLATE NOCASE`).all();
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      euros,
      settings,
      casais,
      historico,
      resumo: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasaCents,
        restoTeorico,
        aplicadoResto,
        restoDisponivel,
      },
      msg: req.query.msg || null,
      err: req.query.err || null,
    });
  } catch (e) {
    next(e);
  }
});

// POST /definicoes/rodizio (guardar config)
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoCents = Math.round(parseFloat(req.body.bloco.replace(',', '.')) * 100) || 0;
    const inicioId = Number(req.body.inicio_casal_id) || null;
    db.prepare(`
      UPDATE settings
      SET rodizio_bloco_cents=?, rodizio_inicio_casal_id=?
      WHERE id=1
    `).run(blocoCents, inicioId);
    res.redirect('/definicoes/rodizio?msg=Definições+atualizadas');
  } catch (e) {
    next(e);
  }
});

// POST /definicoes/rodizio/aplicar
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id);
    const valor = parseFloat(req.body.valor.replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    const settings = ensureSettingsRow();
    const totalCasaCents = Number(settings.rodizio_bloco_cents ?? 500000);
    const recMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;
    const despMov = db.prepare(`
      SELECT IFNULL(SUM(m.valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;
    const ped = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s;
    const pat = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s;
    const saldoMovimentos = recMov - despMov + ped + pat;
    const restoDisponivel = Math.max(0, saldoMovimentos - totalCasaCents);

    if (valor_cents > restoDisponivel + 5) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`INSERT INTO rodizio_aplicacoes (casal_id, valor_cents) VALUES (?,?)`).run(casal_id, valor_cents);
    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) {
    next(e);
  }
});

// POST /definicoes/rodizio/edit/:id
router.post('/definicoes/rodizio/edit/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const valor = parseFloat(req.body.valor.replace(',', '.')) || 0;
    const valor_cents = Math.round(valor * 100);
    if (!id || valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');
    db.prepare(`UPDATE rodizio_aplicacoes SET valor_cents=? WHERE id=?`).run(valor_cents, id);
    res.redirect('/definicoes/rodizio?msg=Valor+atualizado');
  } catch (e) {
    next(e);
  }
});

// POST /definicoes/rodizio/delete/:id
router.post('/definicoes/rodizio/delete/:id', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM rodizio_aplicacoes WHERE id=?`).run(req.params.id);
    res.redirect('/definicoes/rodizio?msg=Aplicação+apagada');
  } catch (e) {
    next(e);
  }
});

export default router;
