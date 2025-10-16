// routes/events.js
import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/* -------- helpers -------- */
function hasCol(table, col) {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
  return cols.includes(col);
}
const HAS_DONE = hasCol('events','done');
const HAS_EFETUADO = hasCol('events','efetuado');

function toIsoDate(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                     // YYYY-MM-DD
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);   // DD/MM/YYYY
  if (m) {
    const [, d, mo, yRaw] = m;
    const y = yRaw.length === 2 ? ('20' + yRaw) : yRaw;
    const pad = n => String(n).padStart(2,'0');
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return s || null;
}

/* -------- LISTAR -------- */
router.get('/events', requireAuth, (req, res) => {
  const cols = ['id','dt','title'];
  if (HAS_DONE) cols.push('COALESCE(done,0) AS done');
  else if (HAS_EFETUADO) cols.push('COALESCE(efetuado,0) AS done');
  else cols.push('0 AS done');

  const events = db.prepare(`
    SELECT ${cols.join(', ')}
    FROM events
    ORDER BY (dt IS NULL), dt, id
  `).all();

  // flash da importação (caso o query string não venha)
  const imported = req.query.import || req.session._imported || null;
  const error = req.query.error || req.session._import_error || null;
  delete req.session._imported;
  delete req.session._import_error;

  res.render('events', {
    title: 'Cronograma',
    user: req.session.user,
    events,
    imported,
    error
  });
});

/* -------- CRIAR -------- */
router.post('/events', requireAuth, (req, res) => {
  const dt = toIsoDate(req.body.dt || null);
  const title = (req.body.title || '').trim() || '(sem descrição)';

  const fields = ['dt','title'];
  const params = [dt, title];
  if (HAS_DONE)     { fields.push('done');     params.push(0); }
  if (HAS_EFETUADO) { fields.push('efetuado'); params.push(0); }

  const placeholders = fields.map(() => '?').join(',');
  db.prepare(`INSERT INTO events (${fields.join(',')}) VALUES (${placeholders})`).run(...params);
  res.redirect('/events');
});

/* -------- EDITAR -------- */
router.post('/events/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const dt = toIsoDate(req.body.dt || null);
  const title = (req.body.title || '').trim() || '(sem descrição)';
  db.prepare(`UPDATE events SET dt=?, title=? WHERE id=?`).run(dt, title, id);
  res.redirect('/events');
});

/* -------- APAGAR -------- */
router.post('/events/:id/delete', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM events WHERE id=?`).run(req.params.id);
  res.redirect('/events');
});

/* -------- TOGGLE EFETUADO -------- */
router.post('/events/:id/done', requireAuth, (req, res) => {
  if (!HAS_DONE && !HAS_EFETUADO) return res.redirect('/events');
  const col = HAS_DONE ? 'done' : 'efetuado';
  const row = db.prepare(`SELECT COALESCE(${col},0) AS d FROM events WHERE id=?`).get(req.params.id);
  const next = row?.d ? 0 : 1;
  const set = HAS_DONE && HAS_EFETUADO ? 'done=?, efetuado=?' : `${col}=?`;
  const params = HAS_DONE && HAS_EFETUADO ? [next, next, req.params.id] : [next, req.params.id];
  db.prepare(`UPDATE events SET ${set} WHERE id=?`).run(...params);
  res.redirect('/events');
});

/* -------- PÁGINA DE IMPORT (GET) -------- */
router.get('/events/import', requireAuth, (req, res) => {
  res.render('import', { title: 'Importar Cronograma', user: req.session.user, msg: null, err: null });
});

/* -------- IMPORTAR (POST) — FICHEIRO dt;title (cabeçalho opcional) -------- */
router.post('/events/import', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      req.session._import_error = 'Falta ficheiro';
      return res.redirect('/events');
    }

    // texto → normalizar quebras e BOM
    let txt = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const delim = (txt.split(';').length >= txt.split(',').length) ? ';' : ',';
    const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);

    if (!lines.length) {
      req.session._import_error = 'Ficheiro vazio';
      return res.redirect('/events');
    }

    // detetar cabeçalho (dt/data/date + título/descrição)
    const header = (lines[0] || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const hasHeader = /(dt|data|date).*(title|t[ií]tulo|descri[cç][aã]o)/.test(header);

    const start = hasHeader ? 1 : 0;
    const ins = db.prepare(`INSERT INTO events (dt, title${HAS_DONE ? ', done' : ''}${HAS_EFETUADO ? ', efetuado' : ''}) VALUES (${['?','?'].concat(HAS_DONE?[0]:[]).concat(HAS_EFETUADO?[0]:[]).map(()=>' ? ').join(',').replace(/\s/g,'')})`);

    let ok = 0;
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].split(delim);
      const rawDt = (parts[0] ?? '').trim();
      const title = (parts[1] ?? '').trim();
      if (!title) continue; // ignorar linhas sem descrição
      const dt = toIsoDate(rawDt);
      // construir args: dt, title, [done], [efetuado]
      const args = [dt, title];
      if (HAS_DONE) args.push(0);
      if (HAS_EFETUADO) args.push(0);
      ins.run(...args);
      ok++;
    }

    req.session._imported = ok;        // flash (mostrado em /events)
    return res.redirect('/events');    // redirect "liso" — o flash garante a mensagem
  } catch (e) {
    console.error('[EVENTS IMPORT] erro:', e);
    req.session._import_error = e.message || 'Erro';
    return res.redirect('/events');
  }
});

/* opcional: ping */
router.get('/events/import/ping', (_req, res) => res.send('OK /events/import'));

export default router;
