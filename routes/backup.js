// routes/backup.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import archiver from 'archiver';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

/* ----------------- helpers comuns ----------------- */

function listTables() {
  return db
    .prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type='table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('sessions')
      ORDER BY name
    `)
    .all();
}

function readTable(name) {
  try {
    return db.prepare(`SELECT * FROM "${name}"`).all();
  } catch {
    return [];
  }
}

function toSqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function eurosFromCents(c) {
  const n = Number(c ?? 0);
  return (n / 100).toFixed(2);
}

// Tenta obter o caminho real do ficheiro da DB
function getDbFilePath() {
  // 1) tentar via better-sqlite3
  try {
    const n = db?.name;
    if (typeof n === 'string' && n && n !== ':memory:') {
      // pode vir como relativo ou com prefixo file:
      if (n.startsWith('file:')) {
        // remover "file:" e eventuais query params (?mode=rw)
        const clean = n.replace(/^file:/, '').split('?')[0];
        return path.isAbsolute(clean) ? clean : path.join(process.cwd(), clean);
      }
      return path.isAbsolute(n) ? n : path.join(process.cwd(), n);
    }
  } catch {}
  // 2) fallback aos envs usados no server.js
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  // 3) fallback por defeito do projeto
  return path.join(process.cwd(), 'data', 'festa.db');
}

// CSV helper (usa ; como separador + primeira linha "sep=;")
function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    const needsQuote = /[;"\r\n]/.test(s) || /^[=+\-@]/.test(s);
    return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  lines.push('sep=;');
  lines.push(headers.map(escape).join(';'));
  for (const row of rows) lines.push(row.map(escape).join(';'));
  res.send(lines.join('\r\n'));
}

/* Resolve o caminho do logo (usa settings.logo_path se existir, senão /public/img/logo.png) */
function resolveLogoPath() {
  try {
    const row = db.prepare(`SELECT logo_path FROM settings WHERE id=1`).get();
    let p = row?.logo_path;
    if (p && p.startsWith('/public/')) {
      const f = path.join(ROOT, p);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  const def = path.join(ROOT, 'public', 'img', 'logo.png');
  return fs.existsSync(def) ? def : null;
}

/* ----------------- página ----------------- */

router.get('/backup', requireAuth, (_req, res) => {
  const tables = listTables();
  const counts = {};
  for (const t of tables) {
    try {
      counts[t.name] = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
    } catch {
      counts[t.name] = 0;
    }
  }
  const dbPath = getDbFilePath();
  res.render('backup', { title: 'Backup', tables, counts, dbPath });
});

/* ----------------- download direto do ficheiro .db ----------------- */
router.get('/backup/download', requireAuth, (req, res, next) => {
  try {
    const dbFile = getDbFilePath();
    if (!dbFile || !fs.existsSync(dbFile)) {
      return res.status(404).type('text').send('Ficheiro de base de dados não encontrado.');
    }
    const filename = `festa-db-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(dbFile).pipe(res);
  } catch (e) {
    next(e);
  }
});

/* ----------------- export JSON ----------------- */
router.get('/backup/export.json', requireAuth, (_req, res) => {
  const tables = listTables();
  const out = {
    meta: { generated_at: new Date().toISOString(), app: 'festa-app', version: 1 },
    schema: {},
    data: {},
  };
  for (const t of tables) {
    out.schema[t.name] = t.sql || null;
    out.data[t.name] = readTable(t.name);
  }
  const filename = `backup-festa-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(out, null, 2));
});

/* ----------------- export SQL ----------------- */
router.get('/backup/export.sql', requireAuth, (_req, res) => {
  const tables = listTables();
  const parts = [];
  parts.push('-- Festa App SQL backup');
  parts.push(`-- Generated: ${new Date().toISOString()}`);
  parts.push('PRAGMA foreign_keys=OFF;');
  parts.push('BEGIN;');
  for (const t of tables) {
    parts.push('');
    parts.push(`-- ========== ${t.name} ==========`);
    parts.push(`DROP TABLE IF EXISTS "${t.name}";`);
    if (t.sql) parts.push(t.sql + ';');
    const rows = readTable(t.name);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      for (const r of rows) {
        const vals = cols.map((c) => toSqlLiteral(r[c])).join(', ');
        parts.push(`INSERT INTO "${t.name}" (${colList}) VALUES (${vals});`);
      }
    }
  }
  parts.push('COMMIT;');
  parts.push('PRAGMA foreign_keys=ON;');
  const sql = parts.join('\n') + '\n';
  const filename = `backup-festa-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sql`;
  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(sql);
});

/* ----------------- export CSVs individuais ----------------- */

router.get('/backup/export/movimentos.csv', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT m.id, m.dt, c.type, c.name AS categoria, m.descr, m.valor_cents
    FROM movimentos m JOIN categorias c ON c.id = m.categoria_id
    ORDER BY date(m.dt) DESC, m.id DESC
  `
    )
    .all();
  const headers = ['id', 'dt', 'type', 'categoria', 'descr', 'valor_cents', 'valor_euros'];
  const data = rows.map((r) => [
    r.id,
    r.dt || '',
    r.type || '',
    r.categoria || '',
    r.descr || '',
    r.valor_cents ?? 0,
    eurosFromCents(r.valor_cents),
  ]);
  sendCsv(res, `movimentos-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

router.get('/backup/export/jantares.csv', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, dt, pessoas, valor_pessoa_cents, despesas_cents
    FROM jantares ORDER BY date(dt) DESC, id DESC
  `
    )
    .all();
  const headers = [
    'id',
    'dt',
    'pessoas',
    'valor_pessoa_cents',
    'valor_pessoa_euros',
    'despesas_cents',
    'despesas_euros',
  ];
  const data = rows.map((r) => [
    r.id,
    r.dt || '',
    r.pessoas ?? 0,
    r.valor_pessoa_cents ?? 0,
    eurosFromCents(r.valor_pessoa_cents),
    r.despesas_cents ?? 0,
    eurosFromCents(r.despesas_cents),
  ]);
  sendCsv(res, `jantares-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

router.get('/backup/export/orcamento.csv', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, dt, descr, valor_cents, notas
    FROM orcamento_servicos ORDER BY date(dt) DESC, id DESC
  `
    )
    .all();
  const headers = ['id', 'dt', 'descr', 'valor_cents', 'valor_euros', 'notas'];
  const data = rows.map((r) => [
    r.id,
    r.dt || '',
    r.descr || '',
    r.valor_cents ?? 0,
    eurosFromCents(r.valor_cents),
    r.notas || '',
  ]);
  sendCsv(res, `orcamento-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

router.get('/backup/export/patrocinadores.csv', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, name, contacto, tipo, valor_prometido_cents, valor_entregue_cents, observ
    FROM patrocinadores ORDER BY name COLLATE NOCASE
  `
    )
    .all();
  const headers = [
    'id',
    'name',
    'contacto',
    'tipo',
    'valor_prometido_cents',
    'valor_prometido_euros',
    'valor_entregue_cents',
    'valor_entregue_euros',
    'observ',
  ];
  const data = rows.map((r) => [
    r.id,
    r.name || '',
    r.contacto || '',
    r.tipo || '',
    r.valor_prometido_cents ?? 0,
    eurosFromCents(r.valor_prometido_cents),
    r.valor_entregue_cents ?? 0,
    eurosFromCents(r.valor_entregue_cents),
    r.observ || '',
  ]);
  sendCsv(res, `patrocinadores-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

router.get('/backup/export/peditorios.csv', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, dt, local, equipa, valor_cents, notas
    FROM peditorios ORDER BY date(dt) DESC, id DESC
  `
    )
    .all();
  const headers = ['id', 'dt', 'local', 'equipa', 'valor_cents', 'valor_euros', 'notas'];
  const data = rows.map((r) => [
    r.id,
    r.dt || '',
    r.local || '',
    r.equipa || '',
    r.valor_cents ?? 0,
    eurosFromCents(r.valor_cents),
    r.notas || '',
  ]);
  sendCsv(res, `peditorios-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

router.get('/backup/export/casais.csv', requireAuth, (_req, res) => {
  const rows = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY id`).all();
  const headers = ['id', 'nome', 'valor_casa_cents', 'valor_casa_euros'];
  const data = rows.map((r) => [r.id, r.nome || '', r.valor_casa_cents ?? 0, eurosFromCents(r.valor_casa_cents)]);
  sendCsv(res, `casais-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
});

/* ----------------- export ZIP: todos CSVs + logo ----------------- */
router.get('/backup/export/all-csv.zip', requireAuth, async (_req, res) => {
  const logoFile = resolveLogoPath(); // <- nome diferente para evitar colisões
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="csv-todos-${new Date().toISOString().slice(0, 10)}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    throw err;
  });
  archive.pipe(res);

  // helper para gerar CSV em memória e anexar
  const addCsv = (name, headers, rows) => {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      const needsQuote = /[;"\r\n]/.test(s) || /^[=+\-@]/.test(s);
      return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['sep=;', headers.map(escape).join(';'), ...rows.map((r) => r.map(escape).join(';'))];
    archive.append(lines.join('\r\n'), { name });
  };

  // movimentos
  {
    const rows = db
      .prepare(
        `
      SELECT m.id, m.dt, c.type, c.name AS categoria, m.descr, m.valor_cents
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      ORDER BY date(m.dt) DESC, m.id DESC
    `
      )
      .all();
    const headers = ['id', 'dt', 'type', 'categoria', 'descr', 'valor_cents', 'valor_euros'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.type || '',
      r.categoria || '',
      r.descr || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
    ]);
    addCsv('movimentos.csv', headers, data);
  }
  // jantares
  {
    const rows = db
      .prepare(
        `SELECT id, dt, pessoas, valor_pessoa_cents, despesas_cents FROM jantares ORDER BY date(dt) DESC, id DESC`
      )
      .all();
    const headers = [
      'id',
      'dt',
      'pessoas',
      'valor_pessoa_cents',
      'valor_pessoa_euros',
      'despesas_cents',
      'despesas_euros',
    ];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.pessoas ?? 0,
      r.valor_pessoa_cents ?? 0,
      eurosFromCents(r.valor_pessoa_cents),
      r.despesas_cents ?? 0,
      eurosFromCents(r.despesas_cents),
    ]);
    addCsv('jantares.csv', headers, data);
  }
  // orcamento
  {
    const rows = db
      .prepare(`SELECT id, dt, descr, valor_cents, notas FROM orcamento_servicos ORDER BY date(dt) DESC, id DESC`)
      .all();
    const headers = ['id', 'dt', 'descr', 'valor_cents', 'valor_euros', 'notas'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.descr || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
      r.notas || '',
    ]);
    addCsv('orcamento.csv', headers, data);
  }
  // patrocinadores
  {
    const rows = db
      .prepare(
        `SELECT id, name, contacto, tipo, valor_prometido_cents, valor_entregue_cents, observ FROM patrocinadores ORDER BY name COLLATE NOCASE`
      )
      .all();
    const headers = [
      'id',
      'name',
      'contacto',
      'tipo',
      'valor_prometido_cents',
      'valor_prometido_euros',
      'valor_entregue_cents',
      'valor_entregue_euros',
      'observ',
    ];
    const data = rows.map((r) => [
      r.id,
      r.name || '',
      r.contacto || '',
      r.tipo || '',
      r.valor_prometido_cents ?? 0,
      eurosFromCents(r.valor_prometido_cents),
      r.valor_entregue_cents ?? 0,
      eurosFromCents(r.valor_entregue_cents),
      r.observ || '',
    ]);
    addCsv('patrocinadores.csv', headers, data);
  }
  // peditorios
  {
    const rows = db
      .prepare(`SELECT id, dt, local, equipa, valor_cents, notas FROM peditorios ORDER BY date(dt) DESC, id DESC`)
      .all();
    const headers = ['id', 'dt', 'local', 'equipa', 'valor_cents', 'valor_euros', 'notas'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.local || '',
      r.equipa || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
      r.notas || '',
    ]);
    addCsv('peditorios.csv', headers, data);
  }
  // casais
  {
    const rows = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY id`).all();
    const headers = ['id', 'nome', 'valor_casa_cents', 'valor_casa_euros'];
    const data = rows.map((r) => [r.id, r.nome || '', r.valor_casa_cents ?? 0, eurosFromCents(r.valor_casa_cents)]);
    addCsv('casais.csv', headers, data);
  }

  // adiciona o logo
  if (logoFile) {
    const ext = path.extname(logoFile).toLowerCase();
    const name = ext === '.png' ? 'logo.png' : 'logo' + ext;
    archive.file(logoFile, { name });
  }

  await archive.finalize();
});

/* ----------------- export XLSX: várias folhas + logo na capa ----------------- */
router.get('/backup/export.xlsx', requireAuth, async (_req, res) => {
  const logoOnCover = resolveLogoPath(); // <- nome diferente para evitar colisões
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Festa App';
  wb.created = new Date();

  // capa
  const ws0 = wb.addWorksheet('Capa');
  ws0.getCell('A2').value = 'Comissão de Festas';
  ws0.getCell('A3').value = 'Backup de dados';
  ws0.getCell('A5').value = `Gerado em: ${new Date().toLocaleString('pt-PT')}`;
  ws0.getColumn(1).width = 40;
  ws0.getRow(2).font = { size: 18, bold: true };
  ws0.getRow(3).font = { size: 14 };
  if (logoOnCover) {
    const ext = path.extname(logoOnCover).toLowerCase().replace('.', '');
    const imgId = wb.addImage({ filename: logoOnCover, extension: ext === 'jpg' ? 'jpeg' : ext });
    ws0.addImage(imgId, { tl: { col: 6, row: 0 }, ext: { width: 180, height: 180 } });
  }

  // helper para criar sheet
  function addSheet(name, headers, rows) {
    const ws = wb.addWorksheet(name);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    // autosize
    headers.forEach((h, i) => {
      let max = h.length;
      for (const row of rows) {
        const v = row[i] == null ? '' : String(row[i]);
        if (v.length > max) max = Math.min(v.length, 60);
      }
      ws.getColumn(i + 1).width = Math.max(10, Math.min(max + 2, 60));
    });
  }

  // folhas
  {
    const rows = db
      .prepare(
        `
      SELECT m.id, m.dt, c.type, c.name AS categoria, m.descr, m.valor_cents
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      ORDER BY date(m.dt) DESC, m.id DESC
    `
      )
      .all();
    const headers = ['id', 'dt', 'type', 'categoria', 'descr', 'valor_cents', 'valor_euros'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.type || '',
      r.categoria || '',
      r.descr || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
    ]);
    addSheet('Movimentos', headers, data);
  }
  {
    const rows = db
      .prepare(
        `SELECT id, dt, pessoas, valor_pessoa_cents, despesas_cents FROM jantares ORDER BY date(dt) DESC, id DESC`
      )
      .all();
    const headers = [
      'id',
      'dt',
      'pessoas',
      'valor_pessoa_cents',
      'valor_pessoa_euros',
      'despesas_cents',
      'despesas_euros',
    ];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.pessoas ?? 0,
      r.valor_pessoa_cents ?? 0,
      eurosFromCents(r.valor_pessoa_cents),
      r.despesas_cents ?? 0,
      eurosFromCents(r.despesas_cents),
    ]);
    addSheet('Jantares', headers, data);
  }
  {
    const rows = db
      .prepare(`SELECT id, dt, descr, valor_cents, notas FROM orcamento_servicos ORDER BY date(dt) DESC, id DESC`)
      .all();
    const headers = ['id', 'dt', 'descr', 'valor_cents', 'valor_euros', 'notas'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.descr || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
      r.notas || '',
    ]);
    addSheet('Orcamento', headers, data);
  }
  {
    const rows = db
      .prepare(
        `SELECT id, name, contacto, tipo, valor_prometido_cents, valor_entregue_cents, observ FROM patrocinadores ORDER BY name COLLATE NOCASE`
      )
      .all();
    const headers = [
      'id',
      'name',
      'contacto',
      'tipo',
      'valor_prometido_cents',
      'valor_prometido_euros',
      'valor_entregue_cents',
      'valor_entregue_euros',
      'observ',
    ];
    const data = rows.map((r) => [
      r.id,
      r.name || '',
      r.contacto || '',
      r.tipo || '',
      r.valor_prometido_cents ?? 0,
      eurosFromCents(r.valor_prometido_cents),
      r.valor_entregue_cents ?? 0,
      eurosFromCents(r.valor_entregue_cents),
      r.observ || '',
    ]);
    addSheet('Patrocinadores', headers, data);
  }
  {
    const rows = db
      .prepare(`SELECT id, dt, local, equipa, valor_cents, notas FROM peditorios ORDER BY date(dt) DESC, id DESC`)
      .all();
    const headers = ['id', 'dt', 'local', 'equipa', 'valor_cents', 'valor_euros', 'notas'];
    const data = rows.map((r) => [
      r.id,
      r.dt || '',
      r.local || '',
      r.equipa || '',
      r.valor_cents ?? 0,
      eurosFromCents(r.valor_cents),
      r.notas || '',
    ]);
    addSheet('Peditorios', headers, data);
  }
  {
    const rows = db.prepare(`SELECT id, nome, valor_casa_cents FROM casais ORDER BY id`).all();
    const headers = ['id', 'nome', 'valor_casa_cents', 'valor_casa_euros'];
    const data = rows.map((r) => [r.id, r.nome || '', r.valor_casa_cents ?? 0, eurosFromCents(r.valor_casa_cents)]);
    addSheet('Casais', headers, data);
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="backup-festa-${new Date().toISOString().slice(0, 10)}.xlsx"`
  );

  await wb.xlsx.write(res);
  res.end();
});

export default router;
