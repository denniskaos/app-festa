import { Router } from 'express';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

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

/* --- página simples (opcional) --- */
router.get('/import', requireAuth, (req, res) => {
  // Se a rota `/events/import` falhar, é provável que a rota que o servidor está 
  // à espera seja apenas `/import` ou que o ficheiro principal não esteja 
  // a definir corretamente o prefixo.
  
  // Vamos assumir que existe um ficheiro `views/import.ejs` (ou similar)
  // Caso contrário, o utilizador teria de fornecer o HTML para esta página
  res.render('import', { title: 'Importar Cronograma', user: req.session.user, msg: req.query.msg || null, err: req.query.err || null });
});

/* --- importar CSV/TXT --- */
router.post('/import', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.redirect('/events?error=' + encodeURIComponent('Falta ficheiro'));

    const name = (req.file.originalname || '').toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.txt')) {
      return res.redirect('/events?error=' + encodeURIComponent('Use .csv ou .txt'));
    }
    
    // Verifica se o ficheiro é legível e lança um erro se for
    const rows = parseCsvFlexible(req.file.buffer);
    if (!rows.length) return res.redirect('/events?error=' + encodeURIComponent('Ficheiro vazio ou ilegível. Tente usar um delimitador diferente (vírgula ou ponto e vírgula).'));
    
    // Verificar se a primeira linha tem pelo menos 2 colunas para ser considerada um cabeçalho
    const firstRowHasEnoughColumns = (rows[0] && rows[0].length >= 2);

    // detetar cabeçalho e índices
    let start = 0, idxDate = 0, idxTitle = 1, idxLocal = -1;
    
    if (firstRowHasEnoughColumns) {
      const header = rows[0].map(String);
      const H = header.map(h => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,''));
      
      const hasHeader =
        H.includes('dt') || H.includes('data') || H.includes('date') ||
        H.includes('title') || H.includes('titulo') || H.includes('descricao') || H.includes('descrição') ||
        H.includes('hora') || H.includes('local');

      if (hasHeader) {
        start = 1;
        const find = arr => arr.map(k => H.indexOf(k)).find(i => i >= 0);
        // Usar o índice encontrado ou forçar 0 e 1, que é o que o CSV tem
        idxDate  = find(['dt','data','date']) ?? 0;
        idxTitle = find(['title','titulo','descricao','descrição']) ?? 1;
        idxLocal = find(['local']); // opcional
      }
    }

    // Se não tiver cabeçalho, começa na linha 0 e assume a ordem 0:data, 1:title
    
    // preparar INSERT de acordo com o esquema
    const fields = ['dt','title'];
    if (EV.hasLocation) fields.push('location');
    if (EV.hasNotes)    fields.push('notes');
    if (EV.hasDone)     fields.push('done');
    if (EV.hasEfetuado) fields.push('efetuado');

    const placeholders = fields.map(() => '?').join(',');
    const ins = db.prepare(`INSERT INTO events (${fields.join(',')}) VALUES (${placeholders})`);

    let ok = 0;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i] || [];
      
      // Adicionar raw values para debug
      const rawDate = r[idxDate] ?? '';
      const rawTitle = r[idxTitle] ?? '';
      
      const title = rawTitle.toString().trim();
      const dt = toIsoDate(rawDate);
      
      // Exigir Data E Título
      if (!title || !dt) {
        // Log muito detalhado para finalmente identificar o problema
        console.log(`[IMPORT FAIL] Linha ignorada ${i+1}. Indices: ${idxDate}/${idxTitle}. Raw Dt: '${rawDate}'. Raw Title: '${rawTitle}'. Processed Dt: '${dt}'. Processed Title: '${title}'. Dados originais: ${r.join(' | ')}`);
        continue; 
      }

      const params = [dt, title];
      if (EV.hasLocation) params.push(idxLocal >= 0 ? (r[idxLocal] || null) : null);
      if (EV.hasNotes)    params.push(null);
      if (EV.hasDone)     params.push(0);
      if (EV.hasEfetuado) params.push(0);

      ins.run(...params);
      ok++;
    }

    // feedback visível no cronograma
    return res.redirect('/events?imported=' + ok); // Mudei "import" para "imported" para corresponder ao HTML
  } catch (e) {
    console.error('[IMPORT /import] erro:', e);
    return res.redirect('/events?error=' + encodeURIComponent(e.message || 'Erro a importar'));
  }
});

export default router;