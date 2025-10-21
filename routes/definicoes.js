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

// tabela para aplicações parciais do resto
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

/* ===================== RODÍZIO (Definições) ===================== */

// helper simples de euros
function euros(centsValue) {
  return ((centsValue || 0) / 100).toFixed(2);
}

// detetar se um jantar já foi lançado (sem depender do ID no texto)
function jantarLancado(j) {
  try {
    const cat = db.prepare(`SELECT id FROM categorias WHERE name='Jantares' AND type='receita'`).get();
    const like = `%${(j.title || j.dt || 'Jantar').trim()}%`;
    if (cat?.id) {
      const row = db.prepare(`
        SELECT 1 AS ok
        FROM movimentos
        WHERE categoria_id=? AND descr LIKE ?
        LIMIT 1
      `).get(cat.id, like);
      return !!row?.ok;
    }
    // fallback: procurar pelo descr apenas
    const row2 = db.prepare(`
      SELECT 1 AS ok FROM movimentos WHERE descr LIKE ? LIMIT 1
    `).get(like);
    return !!row2?.ok;
  } catch {
    return false;
  }
}

// receita paga por jantar (soma do que está marcado como pago nos convidados)
function receitaPagaDoJantar(jid) {
  try {
    return db.prepare(`
      SELECT IFNULL(SUM(pago_cents),0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(jid).s || 0;
  } catch { return 0; }
}

// somas seguras
const sumOr0 = (sql) => { try { return db.prepare(sql).get()?.s ?? 0; } catch { return 0; } };

// GET /definicoes/rodizio  (cartões + parâmetros + aplicar resto)
router.get('/definicoes/rodizio', requireAuth, (req, res, next) => {
  try {
    const settings = ensureSettingsRow();

    // Totais fixos
    const totalCasaCents = sumOr0(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`);
    const blocoCents     = Number(settings.rodizio_bloco_cents ?? 500000);

    // Saldo movimentos (real): receitas - despesas + peditórios + patrocínios (entregues)
    const receitasMov   = sumOr0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s
                                  FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                                  WHERE c.type='receita'`);
    const despesasMov   = sumOr0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s
                                  FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                                  WHERE c.type='despesa'`);
    const peditorios    = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`);
    const patrocinEnt   = sumOr0(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = receitasMov - despesasMov + peditorios + patrocinEnt;

    // Lucro projetado (apenas jantares PENDENTES) = soma(pago) - despesas_jantar
    const jantares = db.prepare(`
      SELECT id, title, dt, COALESCE(despesas_cents,0) AS despesas_cents
      FROM jantares
      ORDER BY COALESCE(dt,'9999-12-31') DESC, id DESC
    `).all();

    let lucroProjetado = 0;
    for (const j of jantares) {
      if (!jantarLancado(j)) {
        const receitaPago = receitaPagaDoJantar(j.id);
        const lucro = receitaPago - (j.despesas_cents || 0);
        lucroProjetado += lucro;
      }
    }

    // Saldo projetado (teórico)
    const saldoProjetado = saldoMovimentos + lucroProjetado;

    // Resto teórico (com lucro projetado)
    const restoTeorico = Math.max(0, saldoProjetado - totalCasaCents);

    // Total já aplicado do resto
    const aplicadoRestoCents = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);

    // Resto disponível (apenas com saldo REAL de movimentos)
    const baseDisponivel = Math.max(0, saldoMovimentos - totalCasaCents);
    const restoDisponivel = Math.max(0, baseDisponivel - aplicadoRestoCents);

    // dados auxiliares para o formulário
    const casais = db.prepare(`SELECT id, nome FROM casais ORDER BY id`).all();

    // histórico das aplicações
    const historico = db.prepare(`
      SELECT a.id, a.dt, a.valor_cents, c.nome AS casal_nome
      FROM rodizio_aplicacoes a
      JOIN casais c ON c.id=a.casal_id
      ORDER BY a.id DESC
    `).all();

    res.render('def_rodizio', {
      title: 'Rodízio',
      settings,
      casais,
      euros,
      // cartões da métrica
      cards: {
        saldoMovimentos,
        lucroProjetado,
        saldoProjetado,
        totalCasa: totalCasaCents,
        restoTeorico,
        restoDisponivel
      },
      // resumo para inputs do formulário
      resumo: {
        blocoCents
      },
      historico,
      msg: req.query.msg || null,
      err: req.query.err || null
    });
  } catch (e) { next(e); }
});

// POST /definicoes/rodizio  (guardar tamanho de bloco e início do rodízio)
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

    // Recalcular RESTO DISPONÍVEL (apenas com saldo real em movimentos)
    const totalCasaCents = sumOr0(`SELECT IFNULL(SUM(valor_casa_cents),0) AS s FROM casais`);
    const receitasMov   = sumOr0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s
                                  FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                                  WHERE c.type='receita'`);
    const despesasMov   = sumOr0(`SELECT IFNULL(SUM(m.valor_cents),0) AS s
                                  FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
                                  WHERE c.type='despesa'`);
    const peditorios    = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM peditorios`);
    const patrocinEnt   = sumOr0(`SELECT IFNULL(SUM(valor_entregue_cents),0) AS s FROM patrocinadores`);
    const saldoMovimentos = receitasMov - despesasMov + peditorios + patrocinEnt;

    const aplicadoRestoCents = sumOr0(`SELECT IFNULL(SUM(valor_cents),0) AS s FROM rodizio_aplicacoes`);
    const baseDisponivel = Math.max(0, saldoMovimentos - totalCasaCents);
    const restoDisponivel = Math.max(0, baseDisponivel - aplicadoRestoCents);

    if (valor_cents > restoDisponivel) {
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
