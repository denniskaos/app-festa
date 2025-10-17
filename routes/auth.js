// routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';

const router = Router();

/* =========================================
   Anti-cache nas páginas /login e /registar
   ========================================= */
router.use(['/login', '/registar'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/* =========================================
   Admin inicial (se não existir)
   ========================================= */
(function ensureAdmin() {
  try {
    const row = db.prepare('SELECT id FROM users WHERE email=?').get('admin@local');
    if (!row) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
        .run('Administrador', 'admin@local', hash, 'admin');
      console.log('✔ Utilizador admin criado: admin@local / admin123');
    }
  } catch (e) {
    console.warn('ensureAdmin falhou:', e.message);
  }
})();

/* =========================================
   Login
   ========================================= */
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Entrar', error: null });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.render('login', { title: 'Entrar', error: 'Preenche email e palavra-passe.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas' });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role || 'viewer' };
  res.redirect('/dashboard');
});

/* =========================================
   Logout
   ========================================= */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid'); // limpa cookie da sessão
    res.redirect('/login');
  });
});

/* =========================================
   Registo
   ========================================= */
router.get('/registar', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  // VIEW: 'register' → ficheiro views/register.ejs
  res.render('register', { title: 'Criar conta', error: null });
});

router.post('/registar', (req, res) => {
  // aceita confirm OU password2 para compatibilidade
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm ?? req.body.password2 ?? '');

  if (!name || !email || !password || !confirm) {
    return res.render('register', { title: 'Criar conta', error: 'Preenche todos os campos.' });
  }
  if (password !== confirm) {
    return res.render('register', { title: 'Criar conta', error: 'As passwords não coincidem.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.render('register', { title: 'Criar conta', error: 'Email inválido.' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (exists) {
    return res.render('register', { title: 'Criar conta', error: 'Esse email já está registado.' });
  }

  // primeiro utilizador vira admin; restantes → viewer
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'viewer';

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
                 .run(name, email, hash, role);

  req.session.user = { id: info.lastInsertRowid, name, email, role };
  res.redirect('/dashboard');
});

export default router;
