import { Router } from 'express';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { logger } from '../lib/logger.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

/* --- helpers --- */
function toIsoDate(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  
  // 1. Tentar YYYY-MM-DD (já está no formato ISO)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; 
  
  // 2. Tentar DD/MM/YYYY ou DD-MM-YYYY (o formato mais comum no CSV carregado)
  // Captura G1: Dia (1-2 dígitos), G2: Mês (1-2 dígitos), G3: Ano (2 ou 4 dígitos)
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/); 
  
  if (m) {
    // Assumimos (Dia, Mês, Ano) para o padrão português/europeu
    const [, d, mo, yRaw] = m;
    
    // Correção do ano: 23 -> 2023
    const y = yRaw.length === 2 ? ('20' + yRaw) : yRaw;
    const pad = (n) => String(n).padStart(2, '0');
    
    // Recompõe para o formato ISO: YYYY-MM-DD
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  
  // 3. Se não corresponder a nenhum formato conhecido
  return s || null;
}

function parseCsvFlexible(buffer) {
  let text = buffer.toString('utf8')
    .replace(/^\uFEFF/, '')   // BOM
    .replace(/\r\n/g, '\n');  // CRLF -> LF
  
  // Remover espaços em branco no início e fim de todo o ficheiro
  text = text.trim(); 

  const semi  = (text.match(/;/g) || []).length;
  const comma = (text.match(/,/g) || []).length;
  
  // Forçar o delimitador a ser ';' se houver mais ';' que ','
  // Isto evita falhas de deteção de ficheiros portugueses/europeus.
  const first = semi >= comma ? ';' : ','; 
  const other = first === ',' ? ';' : ',';

  // Tenta sempre o ponto e vírgula primeiro, garantindo a compatibilidade.
  const tries = [
    { delimiter:';', relax_quotes:true, relax_column_count:true, skip_empty_lines:true, trim:true }, // Tenta ; explicitamente
    { delimiter:first, relax_quotes:true, relax_column_count:true, skip_empty_lines:true, trim:true },
    { delimiter:other, relax_quotes:true, relax_column_count:true, skip_empty_lines:true, trim:true },
    { delimiter:first, quote:null,       relax_column_count:true, skip_empty_lines:true, trim:true },
    { delimiter:other, quote:null,       relax_column_count:true, skip_empty_lines:true, trim:true },
  ];

  let lastErr;
  for (const opt of tries) {
    try { return parseCsv(text, opt); } catch (e) { lastErr = e; }
  }
  // Se todos os tries falharem, lança o último erro.
  throw lastErr; 
}

function eventsSchema() {
  const cols = db.prepare("PRAGMA table_info('events')").all().map(c => c.name);
  return {
    hasLocation: cols.includes('location'),
    hasNotes: cols.includes('notes'),
    hasDone: cols.includes('done'),
    hasEfetuado: cols.includes('efetuado'),
  };
}
const EV = eventsSchema();

function parseEventsFromUpload(fileBuffer, originalname = '') {
  const rows = parseCsvFlexible(fileBuffer);
  if (!rows.length) throw new Error('Ficheiro vazio ou ilegível. Tente usar vírgula ou ponto e vírgula.');

  const firstRowHasEnoughColumns = (rows[0] && rows[0].length >= 2);
  let start = 0;
  let idxDate = 0;
  let idxTitle = 1;
  let idxLocal = -1;

  if (firstRowHasEnoughColumns) {
    const header = rows[0].map(String);
    const H = header
      .map(h => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ''));

    const hasHeader =
      H.includes('dt') || H.includes('data') || H.includes('date') ||
      H.includes('title') || H.includes('titulo') || H.includes('descricao') || H.includes('descrição') ||
      H.includes('hora') || H.includes('local');

    if (hasHeader) {
      start = 1;
      const find = arr => arr.map(k => H.indexOf(k)).find(i => i >= 0);
      idxDate = find(['dt', 'data', 'date']) ?? 0;
      idxTitle = find(['title', 'titulo', 'descricao', 'descrição']) ?? 1;
      idxLocal = find(['local']);
    }
  }

  const prepared = [];
  const errors = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    const rawDate = r[idxDate] ?? '';
    const rawTitle = r[idxTitle] ?? '';
    const title = rawTitle.toString().trim();
    const dt = toIsoDate(rawDate);
    const location = idxLocal >= 0 ? (r[idxLocal] || null) : null;

    if (!title || !dt) {
      errors.push({
        row: i + 1,
        reason: !title ? 'Título em falta' : 'Data inválida/em falta',
        rawDate: String(rawDate || ''),
        rawTitle: String(rawTitle || ''),
      });
      continue;
    }
    prepared.push({ dt, title, location });
  }

  if (prepared.length > 5000) {
    throw new Error('Ficheiro demasiado grande para importação única (máx. 5000 linhas válidas).');
  }

  return {
    fileName: originalname,
    totalRows: rows.length - start,
    prepared,
    errors,
  };
}

/* --- página simples (opcional) --- */
router.get('/import', requireAuth, (req, res) => {
  res.render('import', {
    title: 'Importar Cronograma',
    user: req.session.user,
    msg: req.query.msg || null,
    err: req.query.err || null,
    preview: req.session.importPreview || null,
  });
});

/* --- preview CSV/TXT --- */
router.post('/import', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.redirect('/import?err=' + encodeURIComponent('Falta ficheiro'));

    const name = (req.file.originalname || '').toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.txt')) {
      return res.redirect('/import?err=' + encodeURIComponent('Use .csv ou .txt'));
    }
    const preview = parseEventsFromUpload(req.file.buffer, req.file.originalname || '');
    req.session.importPreview = preview;
    return res.redirect('/import?msg=' + encodeURIComponent(`Preview carregado: ${preview.prepared.length} válidas, ${preview.errors.length} com erro.`));
  } catch (e) {
    logger.warn('import preview failed', { error: e.message });
    return res.redirect('/import?err=' + encodeURIComponent(e.message || 'Erro a analisar ficheiro'));
  }
});

/* --- confirmar preview --- */
router.post('/import/confirm', requireAuth, (req, res) => {
  try {
    const preview = req.session.importPreview;
    if (!preview || !Array.isArray(preview.prepared) || preview.prepared.length === 0) {
      return res.redirect('/import?err=' + encodeURIComponent('Não existe preview para confirmar.'));
    }

    const fields = ['dt', 'title'];
    if (EV.hasLocation) fields.push('location');
    if (EV.hasNotes) fields.push('notes');
    if (EV.hasDone) fields.push('done');
    if (EV.hasEfetuado) fields.push('efetuado');

    const placeholders = fields.map(() => '?').join(',');
    const ins = db.prepare(`INSERT INTO events (${fields.join(',')}) VALUES (${placeholders})`);

    const tx = db.transaction(() => {
      for (const row of preview.prepared) {
        const params = [row.dt, row.title];
        if (EV.hasLocation) params.push(row.location || null);
        if (EV.hasNotes) params.push(null);
        if (EV.hasDone) params.push(0);
        if (EV.hasEfetuado) params.push(0);
        ins.run(...params);
      }
    });
    tx();

    const ok = preview.prepared.length;
    req.session.importPreview = null;
    return res.redirect('/events?imported=' + ok);
  } catch (e) {
    logger.error('import confirm failed', { error: e.message });
    return res.redirect('/import?err=' + encodeURIComponent(e.message || 'Erro ao confirmar importação'));
  }
});

export default router;
