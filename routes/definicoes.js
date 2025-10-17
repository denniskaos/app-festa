// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* --------------------------------------------------
   Helpers
---------------------------------------------------*/
// Garante que existe a linha id=1 e as colunas do rodízio
function ensureSettingsAndRodizio() {
  const row = db.prepare(`SELECT 1 FROM settings WHERE id=1`).get();
  if (!row) db.prepare(`INSERT INTO settings (id) VALUES (1)`).run();

  const cols = db.prepare(`PRAGMA table_info('settings')`).all().map(c => c.name);
  const add = (n, def) => { if (!cols.includes(n)) db.exec(`ALTER TABLE settings ADD COLUMN ${n} ${def}`); };

  add('line1', 'TEXT');
  add('line2', 'TEXT');
  add('logo_path', 'TEXT');
  add('primary_color', 'TEXT');
  add('secondary_color', 'TEXT');
  add('title', 'TEXT');
  add('sub_title', 'TEXT');

  // Rodízio
  add('rodizio_bloco_cents', 'INTEGER NOT NULL DEFAULT 500000');   // 5.000 €
  add('rodizio_inicio_casal_id', 'INTEGER');                        // casal a começar ciclo
  add('rodizio_blocks_aplicados', 'INTEGER NOT NULL DEFAULT 0');    // nº blocos já aplicados
}

// parse "euros" vindo do input (suporta vírgula/ponto)
function parseEurosToCents(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

ensureSettingsAndRodizio();

/* --------------------------------------------------
   Campos base que já tinhas
---------------------------------------------------*/
const KEYS = [
  { key: 'line1', label:'Linha 1 (nome)', type:'text' },
  { key: 'line2', label:'Linha 2 (subtítulo)', type:'text' },
  { key: 'logo_path', label:'Caminho do logótipo', type:'text' },
  { key: 'primary_color', label:'Cor primária', type:'color' },
  { key: 'secondary_color', label:'Cor secundária', type:'color' },
  { key: 'title', label:'Título da página', type:'text' },
  { key: 'sub_title', label:'Sub-título', type:'text' },
];

/* --------------------------------------------------
   GET /definicoes
   -> Envia também dados do rodízio para a mesma view
---------------------------------------------------*/
router.get('/definicoes', requireAuth, (req, res) => {
  ensureSettingsAndRodizio();

  let settings = db.prepare('SELECT * FROM settings WHERE id=1').get();

  // fallback para primeiras execuções
  if (!settings.line1 && !settings.line2 && !settings.primary_color && !settings.secondary_color) {
    db.prepare(`
      UPDATE settings SET
        line1 = COALESCE(line1,'Comisão de Festas'),
        line2 = COALESCE(line2,'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz'),
        primary_color = COALESCE(primary_color,'#1f6feb'),
        secondary_color = COALESCE(secondary_color,'#b58900')
      WHERE id=1
    `).run();
    settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }

  const me = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY id`).all();

  // Resumo do rodízio (para mostrar na página)
  const totalCasaCents = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s;
  const blocoCents = Number(settings.rodizio_bloco_cents ?? 500000);
  const blocksAplicados = Number(settings.rodizio_blocks_aplicados ?? 0);
  const blocosCompletos = blocoCents > 0 ? Math.floor(totalCasaCents / blocoCents) : 0;
  const restoCents      = blocoCents > 0 ? (totalCasaCents - blocosCompletos * blocoCents) : totalCasaCents;
  const novos           = Math.max(0, blocosCompletos - blocksAplicados);

  res.render('definicoes', {
    title:'Definições',
    user:req.session.user,
    KEYS,
    map:settings,
    me,
    casais,                           // para o <select> do início
    rodizioResumo: { totalCasaCents, blocoCents, blocosCompletos, restoCents, blocksAplicados, novos },
    msg:req.query.msg||null,
    err:req.query.err||null
  });
});

/* --------------------------------------------------
   POST /definicoes  (campos base)
---------------------------------------------------*/
router.post('/definicoes', requireAuth, (req, res) => {
  ensureSettingsAndRodizio();

  const fields = KEYS.map(k => k.key);
  const setSql = fields.map(k => `${k}=?`).join(', ');
  const values = fields.map(k => (req.body[k] ?? null));
  db.prepare(`UPDATE settings SET ${setSql} WHERE id=1`).run(...values);
  res.redirect('/definicoes?msg=Definições+guardadas');
});

/* --------------------------------------------------
   Perfil (sem alterações)
---------------------------------------------------*/
router.post('/definicoes/perfil', requireAuth, (req, res) => {
  const { name, email, current_password, new_password, confirm_password } = req.body;
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?')
    .run((name||'').trim(), (email||'').trim(), req.session.user.id);

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

/* ===================== RODÍZIO (Definições) ===================== */

// Atalho opcional: envia para a mesma página focando a secção (#rodizio)
router.get('/definicoes/rodizio', requireAuth, (_req, res) => {
  res.redirect('/definicoes#rodizio');
});

// Guardar configurações do rodízio
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    ensureSettingsAndRodizio();

    // Aceita nomes novos e antigos dos campos
    const blocoCents =
      parseEurosToCents(req.body.rodizio_bloco_euros ?? req.body.bloco ?? 0);

    const inicioIdRaw =
      req.body.rodizio_inicio_casal_id ?? req.body.inicio_casal_id ?? '';

    const inicioId = inicioIdRaw ? Number(inicioIdRaw) : null;

    const aplicadosRaw =
      req.body.rodizio_blocks_aplicados ?? req.body.blocks_aplicados ?? '';

    const aplicados = aplicadosRaw === '' ? null : Math.max(0, parseInt(aplicadosRaw, 10));

    // Garante a linha e atualiza
    db.prepare(`
      UPDATE settings
         SET rodizio_bloco_cents = ?,
             rodizio_inicio_casal_id = ?
       WHERE id=1
    `).run(blocoCents, inicioId);

    if (aplicados !== null && Number.isFinite(aplicados)) {
      db.prepare(`UPDATE settings SET rodizio_blocks_aplicados=? WHERE id=1`).run(aplicados);
    }

    res.redirect('/definicoes#rodizio');
  } catch (e) { next(e); }
});

// Reset dos blocos aplicados
router.post('/definicoes/rodizio/reset', requireAuth, (_req, res, next) => {
  try {
    ensureSettingsAndRodizio();
    db.prepare(`UPDATE settings SET rodizio_blocks_aplicados=0 WHERE id=1`).run();
    res.redirect('/definicoes#rodizio');
  } catch (e) { next(e); }
});

export default router;
