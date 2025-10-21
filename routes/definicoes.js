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
  // rodízio (guardamos aqui o tamanho do bloco e o casal de início)
  { key: 'rodizio_bloco_cents', label:'(interno) bloco cents', type:'text' },
  { key: 'rodizio_inicio_casal_id', label:'(interno) início casal id', type:'text' },
];

// ---- helpers
function ensureSettingsRow() {
  let row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (!row) {
    db.prepare(`
      INSERT INTO settings (id,line1,line2,primary_color,secondary_color)
      VALUES (1,?,?,?,?)
    `).run(
      'Comissão de Festas',
      'em Honra de Nossa Senhora da Graça 2026 - Vila Caiz',
      '#1f6feb',
      '#b58900'
    );
    row = db.prepare('SELECT * FROM settings WHERE id=1').get();
  }
  return row;
}

// tabela para registar aplicações parciais do “resto”
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
})();

// euros helper (mostramos valores em euros a partir de cents)
function euros(centsValue) { return ((centsValue || 0) / 100).toFixed(2); }

// ===================== DEFINIÇÕES BASE =====================
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

// ===================== RODÍZIO =====================
// — Fórmulas pedidas —
// Saldo movimentos = receitas(mov) − despesas(mov) + peditórios + patrocínios
// Lucro projetado (jantares pendentes) = Σ (receita calculada − despesas do jantar) dos NÃO lançados
// Saldo projetado = saldo movimentos + lucro projetado
// Resto teórico = max(0, saldo projetado − total “em casais”)
// Resto disponível = max(0, resto teórico − total já aplicado do resto)

function receitaCalculadaDoJantar(j) {
  // com overrides por convidado (preco_cents) ou preço base
  const base = j.valor_pessoa_cents || 0;
  const agg = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
    FROM jantares_convidados
    WHERE jantar_id=?
  `).get(base, j.id);
  if (!agg || !agg.n) return (j.pessoas || 0) * base;
  return agg.s || 0;
}

function etiquetaJantar(j) {
  return (j.title && j.title.trim()) ? j.title.trim() : (j.dt || `Jantar #${j.id}`);
}
function jantarLancado(j) {
  // consideramos lançado se existir movimento de categoria 'Jantares' com descr começado por 'Jantar — <prefix> — Receita'
  const cat = db.prepare(`SELECT id FROM categorias WHERE type='receita' AND name='Jantares'`).get();
  if (!cat) return false;
  const prefix = `Jantar — ${etiquetaJantar(j)} — Receita`;
  const alt    = `Jantar ${j.dt || ('#'+j.id)} (ID:${j.id}) — Receita`; // compat antigo
  const hit = db.prepare(`
    SELECT 1 AS ok FROM movimentos
    WHERE categoria_id=? AND (descr LIKE ? OR descr LIKE ?) LIMIT 1
  `).get(cat.id, `${prefix}%`, `${alt}%`);
  return !!hit;
}

// GET página do rodízio
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // 1) Somas de movimentos por tipo
    const sumMov = db.prepare(`
      SELECT
        SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END) AS receitas,
        SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END) AS despesas
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    `).get() || { receitas:0, despesas:0 };

    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s || 0;
    const patrocinios = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s || 0;

    const saldoMovimentos = (sumMov.receitas || 0) - (sumMov.despesas || 0) + peditorios + patrocinios;

    // 2) Lucro projetado (jantares pendentes)
    const jantares = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents
      FROM jantares ORDER BY id
    `).all();

    let lucroProjetado = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue; // só os NÃO lançados
      const receita = receitaCalculadaDoJantar(j);
      const lucro   = receita - (j.despesas_cents || 0);
      lucroProjetado += lucro;
    }

    // 3) Saldo projetado
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // 4) Total “em casais”
    const totalCasa = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s || 0;

    // 5) Resto teórico e disponível
    const restoTeorico = Math.max(0, saldoProjetado - totalCasa);

    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s || 0;
    const restoDisponivel = Math.max(0, restoTeorico - aplicadoResto);

    // dados auxiliares para os forms
    const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY id`).all();
    const blocoCents = Number(settings.rodizio_bloco_cents ?? 500000);
    const inicioId   = settings.rodizio_inicio_casal_id || null;

    res.render('def_rodizio', {
      title: 'Rodízio',
      euros,
      // cartões
      cards: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasa,
        restoTeorico,
        aplicadoResto,
        restoDisponivel
      },
      // detalhe do saldo de movimentos
      detalhe: {
        receitas: (sumMov.receitas || 0),
        despesas: (sumMov.despesas || 0),
        peditorios,
        patrocinios
      },
      // forms
      blocoCents,
      inicioId,
      casais,
      // histórico de aplicações
      historico: db.prepare(`
        SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
        FROM rodizio_aplicacoes a JOIN casais c ON c.id=a.casal_id
        ORDER BY a.id DESC
      `).all(),
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// Guardar tamanho do bloco + casal de início
router.post('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const blocoEuros = String(req.body.bloco ?? '').trim().replace(/\s/g,'').replace('.', '').replace(',', '.');
    const blocoCents = Math.round((Number(blocoEuros) || 0) * 100);
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

// Aplicar parte do resto a um casal
router.post('/definicoes/rodizio/aplicar', requireAuth, (req, res, next) => {
  try {
    const casal_id = Number(req.body.casal_id || 0) || null;
    const valorTxt = String(req.body.valor || '').trim().replace(/\s/g,'').replace('.', '').replace(',', '.');
    const valor_cents = Math.round((Number(valorTxt) || 0) * 100);

    if (!casal_id) return res.redirect('/definicoes/rodizio?err=Escolhe+um+casal');
    if (valor_cents <= 0) return res.redirect('/definicoes/rodizio?err=Valor+inválido');

    // Recalcular resto disponível com as MESMAS fórmulas:
    const sumMov = db.prepare(`
      SELECT
        SUM(CASE WHEN c.type='receita' THEN m.valor_cents ELSE 0 END) AS receitas,
        SUM(CASE WHEN c.type='despesa' THEN m.valor_cents ELSE 0 END) AS despesas
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
    `).get() || { receitas:0, despesas:0 };
    const peditorios = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`).get().s || 0;
    const patrocinios = db.prepare(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`).get().s || 0;
    const saldoMovimentos = (sumMov.receitas||0) - (sumMov.despesas||0) + peditorios + patrocinios;

    const jantares = db.prepare(`
      SELECT id, dt, title, pessoas, valor_pessoa_cents, despesas_cents
      FROM jantares
    `).all();
    let lucroProjetado = 0;
    for (const j of jantares) {
      if (jantarLancado(j)) continue;
      const receita = receitaCalculadaDoJantar(j);
      lucroProjetado += (receita - (j.despesas_cents || 0));
    }
    const saldoProjetado = saldoMovimentos + lucroProjetado;
    const totalCasa = db.prepare(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`).get().s || 0;
    const restoTeorico = Math.max(0, saldoProjetado - totalCasa);
    const aplicadoResto = db.prepare(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`).get().s || 0;
    const restoDisponivel = Math.max(0, restoTeorico - aplicadoResto);

    if (valor_cents > restoDisponivel) {
      return res.redirect('/definicoes/rodizio?err=Valor+excede+o+resto+disponível');
    }

    db.prepare(`
      INSERT INTO rodizio_aplicacoes (casal_id, valor_cents)
      VALUES (?, ?)
    `).run(casal_id, valor_cents);

    res.redirect('/definicoes/rodizio?msg=Aplicação+registada');
  } catch (e) { next(e); }
});

export default router;
