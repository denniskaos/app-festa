// server.js
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import SQLiteStoreFactory from 'connect-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// Middleware
import { readOnlyForViewers } from './middleware/roles.js';
import { ensureCsrfToken, sameOriginGuard, verifyCsrfToken } from './lib/security.js';
import { logger } from './lib/logger.js';
import { purgeAuthAuditOlderThan } from './lib/audit.js';

// Rotas
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import eventsRoutes from './routes/events.js';
import jantaresRoutes from './routes/jantares.js';
import jantaresOrgRoutes from './routes/jantares_org.js';
import definicoesRoutes from './routes/definicoes.js';
import casaisRoutes from './routes/casais.js';
import usersRoutes from './routes/users.js';
import financeRoutes from './routes/finance.js';
import importRoutes from './routes/import.js';
import backupRoutes from './routes/backup.js';
import peditoriosRoutes from './routes/peditorios.js';
import securityRoutes from './routes/security.js';

// __dirname em ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
})();

// ---- APP ----
const app = express();
app.disable('x-powered-by');

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const LOG_REQUESTS = process.env.LOG_REQUESTS === '1' || !IS_PROD;
const STRICT_SESSION_SECRET = process.env.STRICT_SESSION_SECRET === '1';
const STRICT_CSRF = process.env.STRICT_CSRF === '1';
const AUTH_AUDIT_RETENTION_DAYS = Math.max(1, Number(process.env.AUTH_AUDIT_RETENTION_DAYS || 180));

// Render está atrás de proxy → cookies e IP corretos
app.set('trust proxy', 1);

// Caminhos/vars
const DB_PATH =
  process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'festa.db');
const SECRET_FALLBACK_SEED =
  process.env.RENDER_EXTERNAL_URL
  || process.env.RENDER_SERVICE_ID
  || DB_PATH
  || 'festa-app';
const FALLBACK_SESSION_SECRET = createHash('sha256')
  .update(`festa-session:${SECRET_FALLBACK_SEED}`)
  .digest('hex');
const EFFECTIVE_SESSION_SECRET = SESSION_SECRET || FALLBACK_SESSION_SECRET;

if (IS_PROD && !SESSION_SECRET) {
  const msg = 'SESSION_SECRET em falta: usar fallback temporário (define SESSION_SECRET no Render).';
  if (STRICT_SESSION_SECRET) throw new Error(`${msg} (STRICT_SESSION_SECRET=1)`);
  logger.warn('session secret missing', { detail: msg });
}

// Em Render (DATABASE_PATH presente) → /data/sessions.sqlite
// Em dev/local → ./data/sessions.sqlite
const SESSIONS_DB =
  process.env.SESSIONS_DB
    || (process.env.DATABASE_PATH
          ? path.join(path.dirname(process.env.DATABASE_PATH), 'sessions.sqlite')
          : path.join(process.cwd(), 'data', 'sessions.sqlite'));

// Garante que a pasta da DB de sessões existe
fs.mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });

// ---- Segurança e performance ----
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// ---- VIEW ENGINE / LAYOUTS ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// desliga cache das views quando DISABLE_VIEW_CACHE=1
if (process.env.DISABLE_VIEW_CACHE === '1') {
  app.set('view cache', false);
}

// express-ejs-layouts: usa views/layout.ejs por omissão
app.set('layout', 'layout');
app.set('layout extractScripts', true);
app.set('layout extractStyles', true);
app.use(expressLayouts);
app.locals.releaseVersion = APP_VERSION;

// ---- ESTÁTICOS ----
app.use(
  '/public',
  express.static(path.join(__dirname, 'public'), {
    maxAge: IS_PROD ? '1d' : 0,
    etag: true,
  })
);

// ---- PARSERS ----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.set('X-Request-ID', req.requestId);
  next();
});

// ---- SESSÃO (persistente) ----
const SQLiteStore = SQLiteStoreFactory(session);
app.use(
  session({
    secret: EFFECTIVE_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      dir: path.dirname(SESSIONS_DB),
      db: path.basename(SESSIONS_DB), // p.ex. sessions.sqlite
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD, // no Render é seguro (TLS no proxy)
      maxAge: 1000 * 60 * 60 * 12, // 12h
    },
  })
);

// ---- USER DISPONÍVEL NAS VIEWS ----
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.csrfToken = ensureCsrfToken(req);
  // Guard rails para evitar 500 por templates antigos/stale em deploy.
  if (typeof res.locals.caixaTotal === 'undefined') res.locals.caixaTotal = 0;
  if (typeof res.locals.topDesvios === 'undefined') res.locals.topDesvios = [];
  next();
});

// ---- LOG DE REQUESTS (ativo por defeito em dev; opcional em prod com LOG_REQUESTS=1) ----
if (LOG_REQUESTS) {
  app.use((req, _res, next) => {
    logger.info('request', {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.session?.user?.id || null,
    });
    next();
  });
}

app.use((req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const validToken = verifyCsrfToken(req);
  if (validToken) return next();

  if (STRICT_CSRF) {
    logger.warn('csrf token missing (strict mode)', {
      requestId: req.requestId,
      method,
      url: req.originalUrl,
    });
    return res.status(403).send('Pedido bloqueado: token CSRF em falta ou inválido.');
  }

  const isSameOrigin = sameOriginGuard(req, { strict: false });
  if (!isSameOrigin) {
    logger.warn('csrf blocked request', { requestId: req.requestId, method, url: req.originalUrl });
    return res.status(403).send('Pedido bloqueado por validação CSRF.');
  }
  logger.warn('csrf token missing; allowed by same-origin fallback', {
    requestId: req.requestId,
    method,
    url: req.originalUrl,
  });
  return next();
});

// ---- HEALTHCHECK (Render) ----
app.get(['/health', '/healthz'], (_req, res) => res.type('text').send('ok'));
app.head(['/', '/health', '/healthz'], (_req, res) => res.status(200).end());
app.get('/', (req, res, next) => {
  const ua = String(req.get('user-agent') || '').toLowerCase();
  if (!req.session?.user && ua.includes('render')) return res.type('text').send('ok');
  return next();
});

// ---- READINESS com verificação à DB ----
app.get('/readyz', (_req, res) => {
  try {
    // 1) o ficheiro existe?
    fs.accessSync(DB_PATH, fs.constants.R_OK);
    // 2) consegue abrir e fazer query?
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT 1 as ok').get();
    db.close();

    if (row?.ok === 1) return res.json({ ok: true, DB_PATH });
    return res.status(503).json({ ok: false, error: 'DB probe failed', DB_PATH });
  } catch (e) {
    return res.status(503).json({ ok: false, error: String(e), DB_PATH });
  }
});

/* ===== BOOT-FIX ++: limpar QUALQUER referência a categorias__old_idx e garantir 'categorias' ===== */
(() => {
  try {
    const dbi = new Database(DB_PATH);

    // (A) DROP de QUALQUER objeto cuja SQL contenha 'categorias__old_idx' ou com esse nome
    const bads = dbi.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name='categorias__old_idx'
         OR sql LIKE '%categorias__old_idx%'
    `).all();

    for (const b of bads) {
      try {
        if (b.type === 'trigger') dbi.exec(`DROP TRIGGER IF EXISTS "${b.name}";`);
        else if (b.type === 'view') dbi.exec(`DROP VIEW IF EXISTS "${b.name}";`);
        else if (b.type === 'table') dbi.exec(`DROP TABLE IF EXISTS "${b.name}";`);
        else if (b.type === 'index') dbi.exec(`DROP INDEX IF EXISTS "${b.name}";`);
      } catch {}
    }

    // (B) se 'categorias' for VIEW (ou não existir / tiver colunas erradas) → reconstruir
    const entry = dbi.prepare(`SELECT type FROM sqlite_master WHERE name='categorias'`).get();
    let needsRecreate = false;
    if (!entry) needsRecreate = true;
    else if (entry.type !== 'table') { try { dbi.exec(`DROP VIEW IF EXISTS categorias;`); } catch {}; needsRecreate = true; }
    else {
      const cols = dbi.prepare(`PRAGMA table_info('categorias')`).all().map(c => c.name);
      if (!cols.includes('id') || !cols.includes('name') || !cols.includes('type') || !cols.includes('planned_cents')) {
        needsRecreate = true;
      }
    }

    // (C) backup (se possível), reconstrução e reposição
    let backupRows = [];
    if (needsRecreate) {
      try { backupRows = dbi.prepare(`SELECT id, name, type, planned_cents FROM categorias`).all(); } catch {}
      dbi.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN;
        DROP TABLE IF EXISTS categorias;
        CREATE TABLE categorias (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('receita','despesa')),
          planned_cents INTEGER NOT NULL DEFAULT 0
        );
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }

    if (needsRecreate) {
      if (backupRows.length) {
        const ins = dbi.prepare(`INSERT OR IGNORE INTO categorias (id,name,type,planned_cents) VALUES (?,?,?,?)`);
        const tx = dbi.transaction(() => {
          for (const r of backupRows) {
            const t = (r.type === 'receita' || r.type === 'despesa') ? r.type : 'receita';
            ins.run(r.id ?? null, r.name ?? 'Genérico', t, r.planned_cents ?? 0);
          }
        });
        tx();
      } else {
        const seed = dbi.prepare(`INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)`);
        seed.run('Genérico', 'receita');
        seed.run('Genérico', 'despesa');
      }
    }

    // (D) índice único correto
    dbi.exec(`CREATE UNIQUE INDEX IF NOT EXISTS categorias_name_type_unique ON categorias(name, type);`);
    dbi.close();

    logger.info('boot-fix categorias ok');
  } catch (e) {
    logger.warn('boot-fix categorias failed', { error: e.message });
  }
})();

// Purga de retenção de auditoria (arranque)
try {
  const removed = purgeAuthAuditOlderThan(AUTH_AUDIT_RETENTION_DAYS);
  logger.info('auth_audit retention purge', {
    days: AUTH_AUDIT_RETENTION_DAYS,
    removed,
  });
} catch (e) {
  logger.warn('auth_audit retention purge failed', { error: e.message });
}

/* ===== BOOT-SCHEMA: garantir tabelas base e seeds mínimos ===== */
(() => {
  try {
    const dbi = new Database(DB_PATH);

    dbi.exec(`
      PRAGMA foreign_keys=ON;

      /* Categorias */
      CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('receita','despesa')),
        planned_cents INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS categorias_name_type_unique ON categorias(name, type);

      /* Movimentos */
      CREATE TABLE IF NOT EXISTS movimentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT,
        categoria_id INTEGER NOT NULL,
        descr TEXT,
        valor_cents INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (categoria_id) REFERENCES categorias(id)
      );

      /* Orçamento de serviços */
      CREATE TABLE IF NOT EXISTS orcamento_servicos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT,
        descr TEXT NOT NULL,
        valor_cents INTEGER NOT NULL DEFAULT 0,
        notas TEXT
      );

      /* Peditórios */
      CREATE TABLE IF NOT EXISTS peditorios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT,
        local TEXT,
        equipa TEXT,
        valor_cents INTEGER NOT NULL DEFAULT 0,
        notas TEXT
      );

      /* Patrocinadores */
      CREATE TABLE IF NOT EXISTS patrocinadores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contacto TEXT,
        valor_cents INTEGER NOT NULL DEFAULT 0,
        observ TEXT,
        tipo TEXT,
        valor_prometido_cents INTEGER NOT NULL DEFAULT 0,
        valor_entregue_cents INTEGER NOT NULL DEFAULT 0
      );

      /* Jantares */
      CREATE TABLE IF NOT EXISTS jantares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT,
        pessoas INTEGER NOT NULL DEFAULT 0,
        valor_pessoa_cents INTEGER NOT NULL DEFAULT 0,
        despesas_cents INTEGER NOT NULL DEFAULT 0
      );

      /* Casais */
      CREATE TABLE IF NOT EXISTS casais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        valor_casa_cents INTEGER NOT NULL DEFAULT 0
      );

      /* Events */
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT,
        title TEXT,
        location TEXT,
        notes TEXT
      );

      /* Users */
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT
      );

      /* Password reset tokens */
      CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);

      /* Settings (linha fixa id=1) */
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id=1),
        title TEXT,
        sub_title TEXT,
        festa_nome TEXT,
        line1 TEXT,
        line2 TEXT,
        logo_path TEXT,
        primary_color TEXT,
        secondary_color TEXT
      );
    `);

    // Ajustes de colunas que podem faltar no events
    try { dbi.exec(`ALTER TABLE events ADD COLUMN done INTEGER NOT NULL DEFAULT 0`); } catch {}
    try { dbi.exec(`ALTER TABLE events ADD COLUMN efetuado INTEGER NOT NULL DEFAULT 0`); } catch {}

    // Seeds idempotentes
    const insCat = dbi.prepare(`INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)`);
    insCat.run('Genérico', 'receita');
    insCat.run('Genérico', 'despesa');

    const rowSet = dbi.prepare(`SELECT 1 FROM settings WHERE id=1`).get();
    if (!rowSet) {
      dbi.prepare(`
        INSERT INTO settings (id, line1, line2, primary_color, secondary_color)
        VALUES (1, 'Comisão de Festas', 'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz', '#1f6feb', '#b58900')
      `).run();
    }

    // Seed casais (só se vazio)
    const cCount = dbi.prepare(`SELECT COUNT(*) AS c FROM casais`).get().c;
    if (cCount === 0) {
      const ins = dbi.prepare(`INSERT INTO casais (nome, valor_casa_cents) VALUES (?, 0)`);
      for (let i = 1; i <= 11; i++) ins.run(`Casal ${i}`);
    }

    dbi.close();
    logger.info('boot-schema ok');
  } catch (e) {
    logger.warn('boot-schema failed', { error: e.message });
  }
})();

/* ======================== ROTAS APLICACIONAIS ======================== */
// Autenticação primeiro (para setar req.session.user)
app.use('/', authRoutes); // /login, /logout, /registar

// Bloquear escrita a viewers **depois** de auth
app.use(readOnlyForViewers);

// Restantes módulos
app.use('/', dashboardRoutes);     // /dashboard
app.use('/', eventsRoutes);        // /events
app.use('/', jantaresRoutes);      // /jantares
app.use('/', jantaresOrgRoutes);   // /organizador (mesas, convidados, print)
app.use('/', definicoesRoutes);    // /definicoes
app.use('/', casaisRoutes);        // /casais
app.use('/', usersRoutes);         // /utilizadores
app.use('/', financeRoutes);       // /orcamento, /movimentos, /patrocinadores
app.use('/', importRoutes);        // /import
app.use('/', backupRoutes);        // /backup
app.use('/', peditoriosRoutes);    // /peditorios
app.use('/', securityRoutes);      // /seguranca/audit

// ---- RAIZ -> PAINEL ----
app.get('/', (_req, res) => res.redirect('/dashboard'));

// ---- 404 SIMPLES ----
app.use((req, res) => {
  res.status(404).type('text').send('404 Not Found');
});

// ---- ERROS ----
app.use((err, _req, res, _next) => {
  logger.error('unhandled error', { error: err?.message || String(err) });
  res.status(500).type('text').send('500 Internal Server Error');
});

// ---- ARRANCAR ----
app.listen(PORT, '0.0.0.0', () => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  logger.info('server started', { url, dbPath: DB_PATH, sessionsDb: SESSIONS_DB });
  logger.info('security mode', { strictCsrf: STRICT_CSRF, strictSessionSecret: STRICT_SESSION_SECRET });
});
