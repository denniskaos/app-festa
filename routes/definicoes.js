// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { ensureSettingsRow } from '../lib/settings.js';

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

// Rodízio foi movido para a secção Casais
router.get('/definicoes/rodizio', requireAuth, (_req, res) => res.redirect('/casais/rodizio'));

export default router;
