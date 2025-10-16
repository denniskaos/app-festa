// routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();

// criar admin se não existir
(function ensureAdmin() {
  const row = db.prepare('SELECT id FROM users WHERE email=?').get('admin@local');
  if (!row) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
      .run('Administrador','admin@local',hash,'admin');
    console.log('✔ Utilizador admin criado: admin@local / admin123');
  }
})();

// LOGIN
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Entrar', error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas' });
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas' });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/dashboard');
});

// LOGOUT
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// REGISTO (Criar conta)
router.get('/registar', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Criar conta', error: null });
});

router.post('/registar', (req, res) => {
  const { name, email, password, confirm } = req.body;
  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim().toLowerCase();

  if (!trimmedName || !trimmedEmail || !password || !confirm) {
    return res.render('register', { title: 'Criar conta', error: 'Preenche todos os campos.' });
  }
  if (password !== confirm) {
    return res.render('register', { title: 'Criar conta', error: 'As passwords não coincidem.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(trimmedEmail);
  if (exists) {
    return res.render('register', { title: 'Criar conta', error: 'Esse email já está registado.' });
  }

  // se for o primeiro utilizador, torna-o admin; senão, viewer
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'viewer';

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
                   .run(trimmedName, trimmedEmail, hash, role);

  // inicia sessão logo após criar
  req.session.user = { id: result.lastInsertRowid, name: trimmedName, email: trimmedEmail, role };
  res.redirect('/dashboard');
});

export default router;
