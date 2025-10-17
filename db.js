// db.js (ESM)
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Caminho da DB: Render usa /data/festa.db (via env), dev usa ./data/festa.db
const LOCAL_DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_LOCAL_DB = path.join(LOCAL_DATA_DIR, 'festa.db');
const DB_PATH = process.env.DATABASE_PATH || DEFAULT_LOCAL_DB;

// Em dev/local garante a pasta ./data
if (!process.env.DATABASE_PATH) {
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}

// Abre a DB
const db = new Database(DB_PATH, { fileMustExist: false, timeout: 5000 });

// Pragmas úteis
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
} catch { /* ignore */ }

// Helper
function columnsOf(table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
}

/* ======================================================
   MIGRAÇÕES (idempotentes) — transação única
   ====================================================== */
const migrate = db.transaction(() => {
  // ---------- Esquema base ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT
    );

    CREATE TABLE IF NOT EXISTS orcamento_servicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT,
      descr TEXT NOT NULL,
      valor_cents INTEGER NOT NULL DEFAULT 0,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS peditorios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT,
      local TEXT,
      equipa TEXT,
      valor_cents INTEGER NOT NULL DEFAULT 0,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('receita','despesa')),
      planned_cents INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS movimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT,
      categoria_id INTEGER NOT NULL,
      descr TEXT,
      valor_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (categoria_id) REFERENCES categorias(id)
    );

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

    CREATE TABLE IF NOT EXISTS jantares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT,
      pessoas INTEGER NOT NULL DEFAULT 0,
      valor_pessoa_cents INTEGER NOT NULL DEFAULT 0,
      despesas_cents INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS casais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT,
      title TEXT,
      location TEXT,
      notes TEXT
    );
  `);

  // --- Organização de jantares: Mesas & Convidados (fora do template) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS jantares_mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jantar_id INTEGER NOT NULL REFERENCES jantares(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      lugares INTEGER NOT NULL DEFAULT 0,
      notas TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jantares_convidados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jantar_id INTEGER NOT NULL REFERENCES jantares(id) ON DELETE CASCADE,
      mesa_id INTEGER REFERENCES jantares_mesas(id) ON DELETE SET NULL,
      nome TEXT NOT NULL,
      contacto TEXT,
      menu TEXT CHECK (menu IN ('normal','vegetariano','sem_gluten','infantil','outro')) DEFAULT 'normal',
      pedido_especial TEXT,
      pago_cents INTEGER NOT NULL DEFAULT 0,
      presenca INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mesas_jantar ON jantares_mesas(jantar_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_convidados_jantar ON jantares_convidados(jantar_id);`);

  /* ---------- SETTINGS: rebuild se faltar 'id' (preserva valores) ---------- */
  {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'`).get();
    if (!exists) {
      db.exec(`
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK (id=1),
          title TEXT,
          sub_title TEXT,
          festa_nome TEXT,
          line1 TEXT,
          line2 TEXT,
          logo_path TEXT,
          primary_color TEXT,
          secondary_color TEXT,
          rodizio_bloco_cents INTEGER NOT NULL DEFAULT 500000,
          rodizio_inicio_casal_id INTEGER,
          rodizio_blocks_aplicados INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO settings (id, line1, line2, primary_color, secondary_color)
        VALUES (1, 'Comisão de Festas', 'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz', '#1f6feb', '#b58900');
      `);
    } else {
      const cols = columnsOf('settings');
      const addCol = (n, def) => { if (!cols.includes(n)) db.exec(`ALTER TABLE settings ADD COLUMN ${n} ${def}`); };
      addCol('title', 'TEXT');
      addCol('sub_title', 'TEXT');
      addCol('festa_nome', 'TEXT');
      addCol('line1', 'TEXT');
      addCol('line2', 'TEXT');
      addCol('logo_path', 'TEXT');
      addCol('primary_color', 'TEXT');
      addCol('secondary_color', 'TEXT');
      addCol('rodizio_bloco_cents', 'INTEGER NOT NULL DEFAULT 500000');  // 5.000 €
      addCol('rodizio_inicio_casal_id', 'INTEGER');
      addCol('rodizio_blocks_aplicados', 'INTEGER NOT NULL DEFAULT 0');

      const row = db.prepare(`SELECT 1 FROM settings WHERE id=1`).get();
      if (!row) db.exec(`INSERT INTO settings (id) VALUES (1)`);
    }
  }

  /* ---------- CATEGORIAS: limpeza de restos e reconstrução segura ---------- */
  (() => {
    // 1) Limpa artefactos antigos
    try {
      db.exec(`
        DROP VIEW    IF EXISTS categorias__old_idx;
        DROP TRIGGER IF EXISTS categorias__old_idx;
        DROP TABLE   IF EXISTS categorias__old_idx;
        DROP INDEX   IF EXISTS categorias__old_idx;
      `);
    } catch {}

    // 2) Se "categorias" for VIEW, remove-a
    const entry = db.prepare(`SELECT type FROM sqlite_master WHERE name='categorias'`).get();
    if (entry && entry.type !== 'table') {
      try { db.exec(`DROP VIEW IF EXISTS categorias;`); } catch {}
    }

    // 3) Verifica colunas e decide rebuild
    const cols = (() => {
      try { return db.prepare(`PRAGMA table_info('categorias')`).all().map(c => c.name); }
      catch { return []; }
    })();

    const precisaRebuild =
      cols.length === 0 ||
      !cols.includes('id') ||
      !cols.includes('name') ||
      !cols.includes('type') ||
      !cols.includes('planned_cents');

    if (precisaRebuild) {
      const existsCat = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='categorias'`).get();

      // Backup (se existir)
      if (existsCat) {
        db.exec(`
          CREATE TEMP TABLE _tmp_cat AS
          SELECT
            COALESCE(id, rowid) AS id,
            COALESCE(name,'Genérico') AS name,
            CASE WHEN type IN ('receita','despesa') THEN type ELSE 'receita' END AS type,
            COALESCE(planned_cents,0) AS planned_cents
          FROM categorias;
        `);
      } else {
        db.exec(`CREATE TEMP TABLE _tmp_cat (id INTEGER, name TEXT, type TEXT, planned_cents INTEGER);`);
      }

      // Rebuild
      db.exec(`
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

      // Restore
      db.exec(`
        INSERT OR IGNORE INTO categorias (id,name,type,planned_cents)
        SELECT id,name,type,planned_cents FROM _tmp_cat;
        DROP TABLE IF EXISTS _tmp_cat;
      `);
    }

    // 4) Índice único correto e limpeza de índices antigos (só name)
    try {
      const idxs = db.prepare(`PRAGMA index_list('categorias')`).all();
      for (const idx of idxs) {
        const colsIdx = db.prepare(`PRAGMA index_info('${idx.name}')`).all().map(r => r.name);
        if (idx.unique && colsIdx.length === 1 && colsIdx[0] === 'name') {
          try { db.exec(`DROP INDEX ${idx.name}`); } catch {}
        }
      }
    } catch {}

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS categorias_name_type_unique ON categorias(name, type);`);

    // 5) Seed idempotente
    const ins = db.prepare('INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)');
    ins.run('Genérico', 'receita');
    ins.run('Genérico', 'despesa');
  })();

  /* ---------- PATROCINADORES: normalizar esquema / colunas antigas ---------- */
  {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='patrocinadores'`).get();

    if (!exists) {
      db.exec(`
        CREATE TABLE patrocinadores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          contacto TEXT,
          valor_cents INTEGER NOT NULL DEFAULT 0,
          observ TEXT,
          tipo TEXT,
          valor_prometido_cents INTEGER NOT NULL DEFAULT 0,
          valor_entregue_cents INTEGER NOT NULL DEFAULT 0
        );
      `);
    } else {
      const cols = columnsOf('patrocinadores');
      const required = ['id','name','contacto','observ','tipo','valor_prometido_cents','valor_entregue_cents'];
      const needsRebuild = !cols.includes('id') || !required.every(c => cols.includes(c));

      if (needsRebuild) {
        db.exec(`ALTER TABLE patrocinadores RENAME TO patrocinadores__old;`);

        db.exec(`
          CREATE TABLE patrocinadores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            contacto TEXT,
            valor_cents INTEGER NOT NULL DEFAULT 0,
            observ TEXT,
            tipo TEXT,
            valor_prometido_cents INTEGER NOT NULL DEFAULT 0,
            valor_entregue_cents INTEGER NOT NULL DEFAULT 0
          );
        `);

        const oldCols = columnsOf('patrocinadores__old');
        const colOrEmpty = c => (oldCols.includes(c) ? c : `''`);

        const sql = `
          INSERT INTO patrocinadores
            (id, name, contacto, valor_cents, observ, tipo, valor_prometido_cents, valor_entregue_cents)
          SELECT
            COALESCE(${colOrEmpty('id')}, rowid),
            COALESCE(${colOrEmpty('name')}, ${colOrEmpty('nome')}, ''),
            COALESCE(${colOrEmpty('contacto')}, ${colOrEmpty('contato')}, ${colOrEmpty('telefone')}, ''),
            COALESCE(${colOrEmpty('valor_cents')}, 0),
            COALESCE(${colOrEmpty('observ')}, ${colOrEmpty('observacoes')}, ''),
            COALESCE(${colOrEmpty('tipo')}, ''),
            COALESCE(${colOrEmpty('valor_prometido_cents')}, ${colOrEmpty('valor_cents')}, 0),
            COALESCE(${colOrEmpty('valor_entregue_cents')}, 0)
          FROM patrocinadores__old;
        `;

        db.exec(sql);
        db.exec(`DROP TABLE patrocinadores__old;`);
      } else {
        const add = (n, def) => { if (!cols.includes(n)) db.exec(`ALTER TABLE patrocinadores ADD COLUMN ${n} ${def}`); };
        add('contacto', 'TEXT');
        add('observ', 'TEXT');
        add('tipo', 'TEXT');
        add('valor_prometido_cents', 'INTEGER NOT NULL DEFAULT 0');
        add('valor_entregue_cents', 'INTEGER NOT NULL DEFAULT 0');
      }
    }
  }

  /* ---------- JANTARES: normalizar esquema / colunas antigas ---------- */
  {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='jantares'`).get();

    if (!exists) {
      db.exec(`
        CREATE TABLE jantares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dt TEXT,
          pessoas INTEGER NOT NULL DEFAULT 0,
          valor_pessoa_cents INTEGER NOT NULL DEFAULT 0,
          despesas_cents INTEGER NOT NULL DEFAULT 0
        );
      `);
    } else {
      const cols = columnsOf('jantares');
      const required = ['id','dt','pessoas','valor_pessoa_cents','despesas_cents'];
      const needsRebuild = !cols.includes('id') || !required.every(c => cols.includes(c));

      if (needsRebuild) {
        db.exec(`ALTER TABLE jantares RENAME TO jantares__old;`);
        db.exec(`
          CREATE TABLE jantares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dt TEXT,
            pessoas INTEGER NOT NULL DEFAULT 0,
            valor_pessoa_cents INTEGER NOT NULL DEFAULT 0,
            despesas_cents INTEGER NOT NULL DEFAULT 0
          );
        `);

        const oldCols = columnsOf('jantares__old');
        const has = (c) => oldCols.includes(c);
        const pickText = (...cs) => { for (const c of cs) if (c && has(c)) return c; return `NULL`; };
        const pickInt  = (...cs) => { for (const c of cs) if (c && has(c)) return c; return `0`; };
        const centsFrom = (centsCols = [], euroCols = []) => {
          for (const c of centsCols) if (has(c)) return c;
          for (const c of euroCols) if (has(c)) return `ROUND(CAST(${c} AS REAL)*100)`;
          return `0`;
        };

        const expr_dt   = pickText('dt', 'data', 'date');
        const expr_pess = pickInt('pessoas', 'qtd', 'quantidade');
        const expr_val  = centsFrom(['valor_pessoa_cents','preco_pessoa_cents'], ['valor_pessoa','preco_pessoa','preco']);
        const expr_desp = centsFrom(['despesas_cents','custo_cents'], ['despesas','custo']);

        const sql = `
          INSERT INTO jantares (id, dt, pessoas, valor_pessoa_cents, despesas_cents)
          SELECT
            ${has('id') ? 'id' : 'rowid'},
            ${expr_dt},
            COALESCE(${expr_pess}, 0),
            COALESCE(${expr_val}, 0),
            COALESCE(${expr_desp}, 0)
          FROM jantares__old;
        `;
        db.exec(sql);
        db.exec(`DROP TABLE jantares__old;`);
      } else {
        const add = (n, def) => { if (!cols.includes(n)) db.exec(`ALTER TABLE jantares ADD COLUMN ${n} ${def}`); };
        add('dt', 'TEXT');
        add('pessoas', 'INTEGER NOT NULL DEFAULT 0');
        add('valor_pessoa_cents', 'INTEGER NOT NULL DEFAULT 0');
        add('despesas_cents', 'INTEGER NOT NULL DEFAULT 0');
      }
    }
  }

  /* ---------- CASAIS: add/migrar valor_casa_cents ---------- */
  {
    const cols = columnsOf('casais');
    if (!cols.includes('valor_casa_cents')) {
      db.exec(`ALTER TABLE casais ADD COLUMN valor_casa_cents INTEGER NOT NULL DEFAULT 0;`);
    }
    if (cols.includes('cash_cents')) {
      db.exec(`
        UPDATE casais
           SET valor_casa_cents = COALESCE(valor_casa_cents, 0) + COALESCE(cash_cents, 0)
         WHERE cash_cents IS NOT NULL;
      `);
    } else if (cols.includes('valor_cents')) {
      db.exec(`
        UPDATE casais
           SET valor_casa_cents = COALESCE(valor_cents, 0)
         WHERE valor_cents IS NOT NULL;
      `);
    }
    const count = db.prepare(`SELECT COUNT(*) AS c FROM casais`).get().c;
    if (count === 0) {
      const ins = db.prepare(`INSERT INTO casais (nome, valor_casa_cents) VALUES (?, 0)`);
      for (let i = 1; i <= 11; i++) ins.run(`Casal ${i}`);
    }
  }

  /* ---------- EVENTS: colunas done/efetuado ---------- */
  {
    const cols = columnsOf('events');
    if (!cols.includes('done'))     db.exec(`ALTER TABLE events ADD COLUMN done INTEGER NOT NULL DEFAULT 0;`);
    if (!cols.includes('efetuado')) db.exec(`ALTER TABLE events ADD COLUMN efetuado INTEGER NOT NULL DEFAULT 0;`);
  }
});

migrate();

/* ================= Helpers de moeda ================= */
export function euros(centsValue) {
  return ((centsValue || 0) / 100).toFixed(2);
}

export function cents(v) {
  const s = String(v ?? '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // remove pontos de milhar
    .replace(',', '.');                // vírgula → ponto
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export default db;
