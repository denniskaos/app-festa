// routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import db from '../db.js';
import { rotateCsrfToken, validatePasswordStrength } from '../lib/security.js';
import { clearLoginRateLimit, clearLoginRateLimitByEmail, loginRateLimit } from '../middleware/loginRateLimit.js';
import { logger } from '../lib/logger.js';
import { logAuthEvent } from '../lib/audit.js';

const router = Router();

/* =========================================
   Anti-cache nas páginas /login e /registar
   ========================================= */
router.use(['/login', '/registar', '/password/forgot', '/password/reset'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

function hashResetToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function createPasswordResetToken(userId) {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(token);
  db.prepare(`
    INSERT INTO password_resets (user_id, token_hash, expires_at)
    VALUES (?, ?, datetime('now', '+30 minutes'))
  `).run(userId, tokenHash);
  return token;
}

function findValidResetToken(token) {
  if (!token) return null;
  const tokenHash = hashResetToken(token);
  return db.prepare(`
    SELECT pr.id, pr.user_id, u.email
    FROM password_resets pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.token_hash = ?
      AND pr.used_at IS NULL
      AND datetime(pr.expires_at) > datetime('now')
    ORDER BY pr.id DESC
    LIMIT 1
  `).get(tokenHash);
}

/* =========================================
   Admin inicial (se não existir)
   ========================================= */
(function ensureAdmin() {
  try {
    const bootstrapPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
    if (!bootstrapPassword) return;

    const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@local').trim().toLowerCase();
    const row = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!row) {
      const strong = validatePasswordStrength(bootstrapPassword);
      if (!strong.ok) {
        logger.warn('admin bootstrap skipped (weak password)', { email });
        return;
      }
      const hash = bcrypt.hashSync(bootstrapPassword, 10);
      db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
        .run('Administrador', email, hash, 'admin');
      logger.info('admin bootstrap created', { email });
    }
  } catch (e) {
    logger.warn('ensureAdmin failed', { error: e.message });
  }
})();

/* =========================================
   Login
   ========================================= */
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Entrar', error: null, msg: req.query.msg || null });
});

router.post('/login', loginRateLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (!email || !password) {
    logAuthEvent({ event: 'login_invalid_input', email, ip });
    return res.render('login', { title: 'Entrar', error: 'Preenche email e palavra-passe.', msg: null });
  }

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    logAuthEvent({ event: 'login_user_not_found', email, ip });
    return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas', msg: null });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    logAuthEvent({ event: 'login_bad_password', email, ip, meta: { userId: user.id } });
    return res.render('login', { title: 'Entrar', error: 'Credenciais inválidas', msg: null });
  }

  clearLoginRateLimit(req);
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role || 'viewer' };
  rotateCsrfToken(req);
  logAuthEvent({ event: 'login_success', email, ip, meta: { userId: user.id } });
  res.redirect('/dashboard');
});

/* =========================================
   Recuperação de password (esqueci-me)
   ========================================= */
router.get('/password/forgot', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('forgot_password', { title: 'Recuperar password', error: null, msg: null, resetLink: null });
});

router.post('/password/forgot', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const genericMsg = 'Se o email existir, enviámos instruções para recuperar a password.';

  if (!email) {
    return res.render('forgot_password', {
      title: 'Recuperar password',
      error: 'Indica o teu email.',
      msg: null,
      resetLink: null,
    });
  }

  // limpeza simples de tokens antigos/expirados
  db.prepare(`DELETE FROM password_resets WHERE used_at IS NOT NULL OR datetime(expires_at) <= datetime('now')`).run();

  const user = db.prepare('SELECT id, email FROM users WHERE email=?').get(email);
  if (!user) {
    logAuthEvent({ event: 'password_reset_requested_unknown_email', email, ip });
    return res.render('forgot_password', {
      title: 'Recuperar password',
      error: null,
      msg: genericMsg,
      resetLink: null,
    });
  }

  // invalida tokens anteriores do mesmo utilizador
  db.prepare(`UPDATE password_resets SET used_at=datetime('now') WHERE user_id=? AND used_at IS NULL`).run(user.id);
  const token = createPasswordResetToken(user.id);
  const resetLink = `${req.protocol}://${req.get('host')}/password/reset?token=${encodeURIComponent(token)}`;

  logAuthEvent({ event: 'password_reset_requested', email, ip, meta: { userId: user.id } });
  logger.info('password reset link generated', { email, resetLink });

  return res.render('forgot_password', {
    title: 'Recuperar password',
    error: null,
    msg: genericMsg,
    // Em produção, não mostrar link no UI (fica em logs para operação).
    resetLink: process.env.NODE_ENV === 'production' ? null : resetLink,
  });
});

router.get('/password/reset', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const token = String(req.query.token || '').trim();
  const row = findValidResetToken(token);
  if (!row) {
    return res.render('reset_password', {
      title: 'Definir nova password',
      error: 'Link inválido ou expirado.',
      msg: null,
      token: '',
    });
  }
  return res.render('reset_password', {
    title: 'Definir nova password',
    error: null,
    msg: null,
    token,
  });
});

router.post('/password/reset', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const row = findValidResetToken(token);

  if (!row) {
    return res.render('reset_password', {
      title: 'Definir nova password',
      error: 'Link inválido ou expirado.',
      msg: null,
      token: '',
    });
  }
  if (!password || password !== confirm) {
    return res.render('reset_password', {
      title: 'Definir nova password',
      error: 'As passwords não coincidem.',
      msg: null,
      token,
    });
  }

  const strong = validatePasswordStrength(password);
  if (!strong.ok) {
    return res.render('reset_password', {
      title: 'Definir nova password',
      error: strong.message,
      msg: null,
      token,
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id);
    db.prepare('UPDATE password_resets SET used_at=datetime(\'now\') WHERE id=?').run(row.id);
  });
  tx();

  clearLoginRateLimitByEmail(row.email);
  logAuthEvent({ event: 'password_reset_success', email: row.email, ip, meta: { userId: row.user_id } });
  return res.redirect('/login?msg=' + encodeURIComponent('Password atualizada com sucesso. Já podes entrar.'));
});

/* =========================================
   Logout
   ========================================= */
router.post('/logout', (req, res) => {
  const email = req.session?.user?.email || null;
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  logAuthEvent({ event: 'logout', email, ip });
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
  const strong = validatePasswordStrength(password);
  if (!strong.ok) {
    return res.render('register', { title: 'Criar conta', error: strong.message });
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
  rotateCsrfToken(req);
  res.redirect('/dashboard');
});

export default router;
