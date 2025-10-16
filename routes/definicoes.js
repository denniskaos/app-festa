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

router.get('/definicoes', requireAuth, (req, res) => {
  let row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (!row) {
    db.prepare('INSERT INTO settings (id,line1,line2,primary_color,secondary_color) VALUES (1,?,?,?,?)')
      .run('Comisão de Festas','em Honra de Nossa Senhora da Graça 2026 - Vila Caiz','#1f6feb','#b58900');
    row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }
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

export default router;
