// routes/definicoes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

const KEYS = [
  { key: 'line1', label:'Linha 1 (nome)', type:'text' },
  { key: 'line2', label:'Linha 2 (subtítulo)', type:'text' },
  { key: 'logo_path', label:'Caminho do logótipo', type:'text' },
  { key: 'primary_color', label:'Cor primária', type:'color' },
  { key: 'secondary_color', label:'Cor secundária', type:'color' },
  { key: 'title', label:'Título da página', type:'text' },
  { key: 'sub_title', label:'Sub-título', type:'text' },
];

/* ===================== BOOT/MIGRAÇÃO ===================== */

// linha fixa na settings
function ensureSettingsRow() {
  let row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO settings (id,line1,line2,primary_color,secondary_color)
      VALUES (1,?,?,?,?)
    `).run(
      'Comisão de Festas',
      'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz',
      '#1f6feb',
      '#b58900'
    );
    row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }
  return row;
}

// tabela para aplicações parciais do resto + coluna lancado_em no jantares
(function ensureRodizioTables(){
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rodizio_aplicacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dt TEXT NOT NULL DEFAULT (date('now')),
        casal_id INTEGER NOT NULL REFERENCES casais(id) ON DELETE CASCADE,
        valor_cents INTEGER NOT NULL CHECK (valor_cents >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_rodizio_aplicacoes_casal ON rodizio_aplicacoes(casal_id);
    `);
  } catch {}

  try {
    const cols = db.prepare(`PRAGMA table_info('jantares')`).all().map(c => c.name);
    if (!cols.includes('lancado_em')) {
      db.exec(`ALTER TABLE jantares ADD COLUMN lancado_em TEXT`);
    }
  } catch {}
})();

/* ===================== DEFINIÇÕES BASE ===================== */

router.get('/definicoes', requireAuth, (req, res) => {
  const row = ensureSettingsRow();
  const me = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.user.id);
  res.render('definicoes', {
    title:'Definições',
    user:req.session.user,
    KEYS,
    map:row,
    me,
    msg:req.query.msg||null,
    err:req.query.err||null
  });
});

router.post('/definicoes', requireAuth, (req, res) => {
  const fields = KEYS.map(k => k.key);
  const setSql = fields.map(k => `${k}=?`).join(', ');
  const values = fields.map(k => (req.body[k] ?? null));
  db.prepare(`UPDATE settings SET ${setSql} WHERE id=1`).run(...values);
  res.redirect('/definicoes?msg=Definições+guardadas');
});

router.post('/definicoes/perfil', requireAuth, (req, res) => {
  const { name, email, current_password, new_password, confirm_password } = req.body;
  db.prepare('UPDATE users SET name=?, email=? WHERE id=?').run((name||'').trim(), (email||'').trim(), req.session.user.id);

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

/* ===================== RODÍZIO (cards + aplicar resto) ===================== */

// helper euros
function euros(c) { return ((c||0)/100).toFixed(2); }
// somas protegidas
const sum0 = (sql) => { try { return db.prepare(sql).get()?.s ?? 0; } catch { return 0; } };

/* Marca lancado_em nos jantares antigos que já tenham movimento de “Receita do Jantar” */
function backfillLancados() {
  const pend = db.prepare(`
    SELECT id, COALESCE(title,'') AS title, COALESCE(dt,'') AS dt
    FROM jantares
    WHERE lancado_em IS NULL
  `).all();

  const likeReceita = (s) => `%Jantar%${s}%Receita%`; // robusto a descrições tipo “Jantar X — Receita”
  const upd = db.prepare(`UPDATE jantares SET lancado_em = datetime('now') WHERE id=?`);

  for (const j of pend) {
    const byTitle = j.title.trim() ? db.prepare(`
      SELECT m.id
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
        AND LOWER(m.descr) LIKE LOWER(?)
      LIMIT 1
    `).get(likeReceita(j.title.trim())) : null;

    const byDate = (!byTitle && j.dt.trim()) ? db.prepare(`
      SELECT m.id
      FROM movimentos m
      JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
        AND LOWER(m.descr) LIKE LOWER(?)
      LIMIT 1
    `).get(likeReceita(j.dt.trim())) : null;

    if (byTitle?.id || byDate?.id) {
      upd.run(j.id);
    }
  }
}

// GET /definicoes/rodizio
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // 1) Backfill para não duplicar jantares já lançados
    backfillLancados();

    // 2) Saldo de movimentos (inclui peditórios + patrocínios entregues)
    const recMov  = sum0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s FROM movimentos m JOIN categorias c ON c.id=m.categoria_id WHERE c.type='receita'`);
    const despMov = sum0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s FROM movimentos m JOIN categorias c ON c.id=m.categoria_id WHERE c.type='despesa'`);
    const ped     = sum0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`);
    const pat     = sum0(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = recMov - despMov + ped + pat;

    // 3) Lucro projetado APENAS dos jantares pendentes
    const lucroProjetado = db.prepare(`
      SELECT COALESCE(SUM(
        /* receita real confirmada (pagos + presença) */
        COALESCE((SELECT IFNULL(SUM(pago_cents),0)
                  FROM jantares_convidados c
                  WHERE c.jantar_id=j.id AND presenca=1),0)
        -
        /* despesas reais (linhas, senão a coluna antiga) */
        COALESCE((SELECT IFNULL(SUM(valor_cents),0)
                  FROM jantares_despesas d
                  WHERE d.jantar_id=j.id),
                 COALESCE(j.despesas_cents,0))
      ),0) AS s
      FROM jantares j
      WHERE j.lancado_em IS NULL
    `).get().s || 0;

    // 4) Totais “em casais” e aplicações de resto
    const totalCasa = sum0(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`);
    const aplicadoRestoCents = sum0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);

    // 5) Saldos finais
    const saldoProjetado = saldoMovimentos + lucroProjetado;
    const restoTeoricoCents = Math.max(0, saldoProjetado - totalCasa);
    const restoDisponivelCents = Math.max(0, restoTeoricoCents - aplicadoRestoCents);

    // 6) Auxiliares para o ecrã
    const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY id`).all();
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      settings,
      euros,
      cards: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasa,
        restoTeoricoCents,
        aplicadoRestoCents,
        restoDisponivelCents
      },
      casais,
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio  (guardar bloco e início)
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoEuros = String(req.body.bloco ?? '').trim();
    const blocoCents = Math.round(Number(blocoEuros.replace(',', '.')) * 100) || 0;
    const inicioId   = req.body.inicio_casal_id ? Number(req.body.inicio_casal_id) : null;

    ensureSettingsRow();
    db.prepare(`
      UPDATE settings
         SET rodizio_bloco_cents = ?,
             rodizio_inicio_casal_id = ?
       WHERE id=1
    `).run(blocoCents, inicioId);

    res.redirect('/definicoes/rodizio?msg=Definições+de+rodízio+guardadas');
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio/aplicar  (aplicar parte do resto a um casal)
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0) || null;
    const valorTxt = String(req.body.valor || '').trim().replace(/\s/g,'').replace('.', '').replace(',', '.');
    const valor_cents = Math.round((Number(valorTxt) || 0) * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcular saldos “ao momento”
    backfillLancados();

    const recMov  = sum0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s FROM movimentos m JOIN categorias c ON c.id=m.categoria_id WHERE c.type='receita'`);
    const despMov = sum0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s FROM movimentos m JOIN categorias c ON c.id=m.categoria_id WHERE c.type='despesa'`);
    const ped     = sum0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`);
    const pat     = sum0(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = recMov - despMov + ped + pat;

    const lucroProjetado = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE((SELECT IFNULL(SUM(pago_cents),0) FROM jantares_convidados c WHERE c.jantar_id=j.id AND presenca=1),0)
        -
        COALESCE((SELECT IFNULL(SUM(valor_cents),0) FROM jantares_despesas d WHERE d.jantar_id=j.id), COALESCE(j.despesas_cents,0))
      ),0) AS s
      FROM jantares j
      WHERE j.lancado_em IS NULL
    `).get().s || 0;

    const totalCasa = sum0(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`);
    const aplicadoRestoCents = sum0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
    const restoDisponivelCents = Math.max(0, Math.max(0, (saldoMovimentos + lucroProjetado) - totalCasa) - aplicadoRestoCents);

    if (valor_cents > restoDisponivelCents) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`
      INSERT INTO rodizio_aplicacoes (casal_id, valor_cents)
      VALUES (?, ?)
    `).run(casal_id, valor_cents);

    return res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

export default router;


