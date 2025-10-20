// routes/jantares_org.js (ESM)
import { Router } from 'express';
import db, { cents, euros } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* ---------- Migrações defensivas (runtime) ---------- */
(function ensureSchema() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jantares_despesas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jantar_id INTEGER NOT NULL REFERENCES jantares(id) ON DELETE CASCADE,
        descr TEXT NOT NULL,
        valor_cents INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_despesas_jantar ON jantares_despesas(jantar_id);
    `);
  } catch {}

  try {
    const cols = db.prepare(`PRAGMA table_info('jantares_convidados')`).all().map(c => c.name);
    if (!cols.includes('preco_cents')) {
      db.exec(`ALTER TABLE jantares_convidados ADD COLUMN preco_cents INTEGER`);
    }
  } catch {}
})();

/* --- Constantes/Helpers --- */
const MENU_LABEL = {
  normal: 'Normal',
  vegetariano: 'Vegetariano',
  sem_gluten: 'Sem glúten',
  infantil: 'Infantil',
  outro: 'Outro',
};

function getSettings() {
  return db.prepare(`SELECT * FROM settings WHERE id=1`).get() || {};
}

function getJantarOr404(id) {
  const j = db.prepare(`SELECT * FROM jantares WHERE id=?`).get(id);
  if (!j) {
    const err = new Error('Jantar não encontrado');
    err.status = 404;
    throw err;
  }
  return j;
}

// Para cabeçalhos/UX: usa título se existir, senão data, senão “Jantar #id”
function etiquetaJantar(j) {
  const t = (j.title || '').trim();
  return t || j.dt || `Jantar #${j.id}`;
}

// Para movimentos: prefixo explícito “Jantar — …”
function labelMovBase(j) {
  const core = (j.title || '').trim() || j.dt || `#${j.id}`;
  return `Jantar — ${core}`;
}

function navUrls(jantar_id) {
  return {
    base: `/jantares/${jantar_id}/organizar`,
    mesas: `/jantares/${jantar_id}/mesas`,
    convidados: `/jantares/${jantar_id}/convidados`,
    despesas: `/jantares/${jantar_id}/despesas`,
    lancar: `/jantares/${jantar_id}/lancar`,
    print: `/jantares/${jantar_id}/mesas/print`,
  };
}

// Garante categoria (aceita várias grafias) e devolve o id
function ensureCategoriaMulti(names, type /* 'receita' | 'despesa' */) {
  for (const name of names) {
    const row = db.prepare(`SELECT id FROM categorias WHERE name=? AND type=?`).get(name, type);
    if (row?.id) return Number(row.id);
  }
  const ins = db.prepare(`INSERT INTO categorias (name, type, planned_cents) VALUES (?,?,0)`)
    .run(names[0], type);
  return Number(ins.lastInsertRowid);
}

// Receita do jantar (considera override por convidado ou valor base)
function receitaPorJantarCents(j) {
  const base = j.valor_pessoa_cents || 0;
  const agg = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(COALESCE(preco_cents, ?)), 0) AS s
    FROM jantares_convidados
    WHERE jantar_id=?
  `).get(base, j.id);

  if (!agg || !agg.n) return (j.pessoas || 0) * base; // fallback se não há convidados
  return agg.s || 0;
}

// Recalcula e atualiza o total de despesas no jantar
function recalcDespesas(jantar_id) {
  const sum = db.prepare(`
    SELECT IFNULL(SUM(valor_cents),0) AS s
    FROM jantares_despesas
    WHERE jantar_id=?
  `).get(jantar_id).s;
  db.prepare(`UPDATE jantares SET despesas_cents=? WHERE id=?`).run(sum, jantar_id);
  return sum;
}

// Insere movimento se não existir um igual (descr+dt+valor+categoria)
function insertMovimentoIfNotExists({ dt, categoria_id, descr, valor_cents }) {
  const exists = db.prepare(`
    SELECT id FROM movimentos
    WHERE dt IS ? AND categoria_id=? AND descr=? AND valor_cents=?
  `).get(dt || null, categoria_id, descr, valor_cents);
  if (exists?.id) return Number(exists.id);

  db.prepare(`
    INSERT INTO movimentos (dt, categoria_id, descr, valor_cents)
    VALUES (?,?,?,?)
  `).run(dt || null, categoria_id, descr, valor_cents);

  return Number(db.prepare(`SELECT last_insert_rowid() AS id`).get().id);
}

// Já foi lançado? (aceita formato novo “Jantar — … — Receita”, o anterior “<titulo> — Receita” e o antigo com “(ID:x)”)
function isLancado(j) {
  const catReceitaId = ensureCategoriaMulti(['Jantares'], 'receita');
  const dtMov = j.dt || null;
  const descrNew = `${labelMovBase(j)} — Receita`;
  const descrOld = `${etiquetaJantar(j)} — Receita`;
  const marker = `(ID:${j.id})`;

  const row = db.prepare(`
    SELECT 1 AS ok
    FROM movimentos
    WHERE categoria_id = ?
      AND dt IS ?
      AND (descr = ? OR descr = ? OR descr LIKE ?)
    LIMIT 1
  `).get(catReceitaId, dtMov, descrNew, descrOld, `%${marker}%`);
  return !!row?.ok;
}

/* =========================================================
   PÁGINA BASE "ORGANIZAR"
   ========================================================= */
router.get('/jantares/:id/organizar', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);

    const mesas = db.prepare(`
      SELECT m.*,
             (SELECT COUNT(*) FROM jantares_convidados c WHERE c.mesa_id=m.id) AS ocupados
      FROM jantares_mesas m
      WHERE m.jantar_id=?
      ORDER BY m.id
    `).all(j.id);

    const totConvidados = db.prepare(`
      SELECT COUNT(*) AS c FROM jantares_convidados WHERE jantar_id=?
    `).get(j.id).c;

    res.render('jantares_org', {
      title: `Organizar — ${etiquetaJantar(j)}`,
      j: { ...j, lancado: isLancado(j) },
      mesas,
      totConvidados,
      euros,
      urls: navUrls(j.id),
    });
  } catch (e) { next(e); }
});

/* =========================================================
   MESAS
   ========================================================= */
router.get('/jantares/:id/mesas', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const mesas = db.prepare(`
      SELECT m.*,
             (SELECT COUNT(*) FROM jantares_convidados c WHERE c.mesa_id=m.id) AS ocupados
      FROM jantares_mesas m
      WHERE m.jantar_id=?
      ORDER BY m.id
    `).all(j.id);

    res.render('jantares_mesas', { title: 'Mesas', j, mesas, urls: navUrls(j.id) });
  } catch (e) { next(e); }
});

router.post('/jantares/:id/mesas', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const nome = String(req.body.nome || '').trim();
    const lugares = Math.max(0, parseInt(req.body.lugares || '0', 10));
    const notas = (req.body.notas || '').trim();
    if (!nome) return res.redirect(`/jantares/${j.id}/mesas`);
    db.prepare(`
      INSERT INTO jantares_mesas (jantar_id,nome,lugares,notas)
      VALUES (?,?,?,?)
    `).run(j.id, nome, lugares, notas);
    res.redirect(`/jantares/${j.id}/mesas`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/mesas/:mid', requireAuth, (req, res, next) => {
  try {
    getJantarOr404(req.params.jid);
    const nome = String(req.body.nome || '').trim();
    const lugares = Math.max(0, parseInt(req.body.lugares || '0', 10));
    const notas = (req.body.notas || '').trim();
    db.prepare(`
      UPDATE jantares_mesas
         SET nome=?, lugares=?, notas=?
       WHERE id=? AND jantar_id=?
    `).run(nome, lugares, notas, req.params.mid, req.params.jid);
    res.redirect(`/jantares/${req.params.jid}/mesas`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/mesas/:mid/delete', requireAuth, (req, res, next) => {
  try {
    getJantarOr404(req.params.jid);
    db.prepare(`UPDATE jantares_convidados SET mesa_id=NULL WHERE mesa_id=?`).run(req.params.mid);
    db.prepare(`DELETE FROM jantares_mesas WHERE id=? AND jantar_id=?`).run(req.params.mid, req.params.jid);
    res.redirect(`/jantares/${req.params.jid}/mesas`);
  } catch (e) { next(e); }
});

/* =========================================================
   CONVIDADOS
   ========================================================= */
router.get('/jantares/:id/convidados', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const mesas = db.prepare(`SELECT * FROM jantares_mesas WHERE jantar_id=? ORDER BY id`).all(j.id);
    const convidados = db.prepare(`
      SELECT c.*, m.nome AS mesa_nome
      FROM jantares_convidados c
      LEFT JOIN jantares_mesas m ON m.id=c.mesa_id
      WHERE c.jantar_id=?
      ORDER BY COALESCE(m.nome, 'zzz'), c.id
    `).all(j.id);

    const sumPago = db.prepare(`
      SELECT IFNULL(SUM(pago_cents),0) AS s
      FROM jantares_convidados
      WHERE jantar_id=?
    `).get(j.id).s;

    res.render('jantares_convidados', {
      title: 'Convidados',
      j, mesas, convidados, sumPago, euros,
      urls: navUrls(j.id),
      MENU_LABEL,
    });
  } catch (e) { next(e); }
});

router.post('/jantares/:id/convidados', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const nome = String(req.body.nome || '').trim();
    if (!nome) return res.redirect(`/jantares/${j.id}/convidados`);
    const mesa_id = req.body.mesa_id ? Number(req.body.mesa_id) : null;
    const contacto = (req.body.contacto || '').trim();
    const menu = (req.body.menu || 'normal');
    const pedido_especial = (req.body.pedido_especial || '').trim();
    const pago_cents = cents(req.body.pago || 0);

    let preco_cents = null;
    const precoTxt = String(req.body.preco ?? '').trim();
    if (precoTxt !== '') preco_cents = cents(precoTxt);

    db.prepare(`
      INSERT INTO jantares_convidados
      (jantar_id, mesa_id, nome, contacto, menu, pedido_especial, pago_cents, presenca, preco_cents)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(j.id, mesa_id, nome, contacto, menu, pedido_especial, pago_cents, 0, preco_cents);

    res.redirect(`/jantares/${j.id}/convidados`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/convidados/:cid', requireAuth, (req, res, next) => {
  try {
    getJantarOr404(req.params.jid);
    const mesa_id = req.body.mesa_id ? Number(req.body.mesa_id) : null;
    const nome = String(req.body.nome || '').trim();
    const contacto = (req.body.contacto || '').trim();
    const menu = (req.body.menu || 'normal');
    const pedido_especial = (req.body.pedido_especial || '').trim();
    const pago_cents = cents(req.body.pago || 0);
    const presenca = req.body.presenca ? 1 : 0;

    let preco_cents = null;
    const precoTxt = String(req.body.preco ?? '').trim();
    if (precoTxt !== '') preco_cents = cents(precoTxt);

    db.prepare(`
      UPDATE jantares_convidados
         SET mesa_id=?,
             nome=?,
             contacto=?,
             menu=?,
             pedido_especial=?,
             pago_cents=?,
             presenca=?,
             preco_cents=?
       WHERE id=? AND jantar_id=?
    `).run(mesa_id, nome, contacto, menu, pedido_especial, pago_cents, presenca, preco_cents, req.params.cid, req.params.jid);

    res.redirect(`/jantares/${req.params.jid}/convidados`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/convidados/:cid/delete', requireAuth, (req, res, next) => {
  try {
    getJantarOr404(req.params.jid);
    db.prepare(`DELETE FROM jantares_convidados WHERE id=? AND jantar_id=?`).run(req.params.cid, req.params.jid);
    res.redirect(`/jantares/${req.params.jid}/convidados`);
  } catch (e) { next(e); }
});

/* =========================================================
   DESPESAS
   ========================================================= */
router.get('/jantares/:id/despesas', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const linhas = db.prepare(`
      SELECT id, descr, valor_cents
      FROM jantares_despesas
      WHERE jantar_id=?
      ORDER BY id
    `).all(j.id);
    const total = linhas.reduce((a, r) => a + (r.valor_cents || 0), 0);

    res.render('jantares_despesas', {
      title: 'Despesas',
      j, linhas, total, euros,
      urls: navUrls(j.id)
    });
  } catch (e) { next(e); }
});

router.post('/jantares/:id/despesas', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const descr = String(req.body.descr || '').trim();
    const valor_cents = cents(req.body.valor || 0);
    if (descr && valor_cents) {
      db.prepare(`
        INSERT INTO jantares_despesas (jantar_id, descr, valor_cents)
        VALUES (?,?,?)
      `).run(j.id, descr, valor_cents);
      recalcDespesas(j.id);
    }
    res.redirect(`/jantares/${j.id}/despesas`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/despesas/:did', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.jid);
    const descr = String(req.body.descr || '').trim();
    const valor_cents = cents(req.body.valor || 0);
    db.prepare(`
      UPDATE jantares_despesas
         SET descr=?, valor_cents=?
       WHERE id=? AND jantar_id=?
    `).run(descr, valor_cents, req.params.did, j.id);
    recalcDespesas(j.id);
    res.redirect(`/jantares/${j.id}/despesas`);
  } catch (e) { next(e); }
});

router.post('/jantares/:jid/despesas/:did/delete', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.jid);
    db.prepare(`DELETE FROM jantares_despesas WHERE id=? AND jantar_id=?`).run(req.params.did, j.id);
    recalcDespesas(j.id);
    res.redirect(`/jantares/${j.id}/despesas`);
  } catch (e) { next(e); }
});

/* =========================================================
   LANÇAR MOVIMENTOS (GET/POST + aliases)
   ========================================================= */
function lancarMovimentos(j) {
  const dtMov = j.dt || null;
  const catReceitaId = ensureCategoriaMulti(['Jantares'], 'receita');
  const catDespesaId = ensureCategoriaMulti(['Jantares — Despesas', 'Jantares — Despesa'], 'despesa');

  const label = labelMovBase(j); // <<< sempre “Jantar — …”

  // Receita
  const receita_cents = receitaPorJantarCents(j);
  if (receita_cents > 0) {
    const descrR = `${label} — Receita`;
    insertMovimentoIfNotExists({
      dt: dtMov,
      categoria_id: catReceitaId,
      descr: descrR,
      valor_cents: receita_cents
    });
  }

  // Despesas (cada linha vira 1 movimento)
  const linhas = db.prepare(`
    SELECT descr, valor_cents
    FROM jantares_despesas
    WHERE jantar_id=?
  `).all(j.id);

  for (const ln of linhas) {
    if (!ln.valor_cents) continue;
    const descrD = `${label} — ${ln.descr}`;
    insertMovimentoIfNotExists({
      dt: dtMov,
      categoria_id: catDespesaId,
      descr: descrD,
      valor_cents: ln.valor_cents
    });
  }

  return {
    receita_cents,
    despesas_cents: linhas.reduce((a, r) => a + (r.valor_cents || 0), 0)
  };
}

function handleLancar(req, res, next) {
  try {
    const j = getJantarOr404(req.params.id || req.params.jid);
    const resumo = lancarMovimentos(j);
    // 303 para não re-submeter o POST ao voltar
    return res.redirect(303, `/movimentos?msg=${encodeURIComponent(
      `Movimentos lançados: ${labelMovBase(j)} — receita € ${(resumo.receita_cents/100).toFixed(2)} e despesas € ${(resumo.despesas_cents/100).toFixed(2)}`
    )}`);
  } catch (e) { next(e); }
}

// Endpoints primários
router.post('/jantares/:id/lancar', requireAuth, handleLancar);
router.get('/jantares/:id/lancar', requireAuth, handleLancar);

// Aliases (compat): /despesas/lancar
router.post('/jantares/:id/despesas/lancar', requireAuth, handleLancar);
router.get('/jantares/:id/despesas/lancar', requireAuth, handleLancar);

/* =========================================================
   IMPRIMIR MESAS
   ========================================================= */
router.get('/jantares/:id/mesas/print', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const settings = getSettings();

    const mesas = db.prepare(`
      SELECT id, nome, lugares, notas
      FROM jantares_mesas
      WHERE jantar_id=?
      ORDER BY id
    `).all(j.id);

    const convidadosPorJantar = db.prepare(`
      SELECT id, mesa_id, nome, contacto, menu, pedido_especial, pago_cents
      FROM jantares_convidados
      WHERE jantar_id=?
      ORDER BY id
    `).all(j.id);

    const byMesa = new Map();
    for (const m of mesas) byMesa.set(m.id, []);
    for (const c of convidadosPorJantar) {
      if (c.mesa_id && byMesa.has(c.mesa_id)) byMesa.get(c.mesa_id).push(c);
    }

    const mesasOut = mesas.map(m => {
      const lst = byMesa.get(m.id) || [];
      const contagem = { normal:0, vegetariano:0, sem_gluten:0, infantil:0, outro:0 };
      for (const c of lst) contagem[c.menu] = (contagem[c.menu] || 0) + 1;
      return { ...m, convidados: lst, contagem };
    });

    const semMesa = convidadosPorJantar
      .filter(c => !c.mesa_id)
      .map(c => ({
        convidado_nome: c.nome,
        menu: c.menu,
        pedido_especial: c.pedido_especial,
        pago_cents: c.pago_cents,
      }));

    const totais = { normal:0, vegetariano:0, sem_gluten:0, infantil:0, outro:0 };
    for (const m of mesasOut) for (const k of Object.keys(totais)) totais[k] += (m.contagem[k] || 0);
    for (const s of semMesa) totais[s.menu] = (totais[s.menu] || 0) + 1;

    res.render('jantares_mesas_print', {
      layout: false,
      minimal: true,
      settings,
      jantar: j,
      mesas: mesasOut,
      semMesa,
      MENU_LABEL,
      totais,
      now: new Date(),
    });
  } catch (e) { next(e); }
});

export default router;
