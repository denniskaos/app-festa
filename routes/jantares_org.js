// routes/jantares_org.js (ESM)
import { Router } from 'express';
import db, { cents, euros } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

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

function navUrls(jantar_id) {
  return {
    base: `/jantares/${jantar_id}/organizar`,
    mesas: `/jantares/${jantar_id}/mesas`,
    convidados: `/jantares/${jantar_id}/convidados`,
    print: `/jantares/${jantar_id}/mesas/print`,
  };
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
      title: `Organizar — ${j.dt || 'Jantar #' + j.id}`,
      j,
      mesas,
      totConvidados,
      euros,
      urls: navUrls(j.id),
    });
  } catch (e) { next(e); }
});

/* =========================================================
   MESAS (listar/criar/editar/apagar)
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

    res.render('jantares_mesas', {
      title: 'Mesas',
      j,
      mesas,
      urls: navUrls(j.id),
    });
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
    // Liberta convidados dessa mesa
    db.prepare(`UPDATE jantares_convidados SET mesa_id=NULL WHERE mesa_id=?`).run(req.params.mid);
    db.prepare(`DELETE FROM jantares_mesas WHERE id=? AND jantar_id=?`).run(req.params.mid, req.params.jid);
    res.redirect(`/jantares/${req.params.jid}/mesas`);
  } catch (e) { next(e); }
});

/* =========================================================
   CONVIDADOS (listar/criar/editar/apagar)
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

    db.prepare(`
      INSERT INTO jantares_convidados
      (jantar_id, mesa_id, nome, contacto, menu, pedido_especial, pago_cents, presenca)
      VALUES (?,?,?,?,?,?,?,0)
    `).run(j.id, mesa_id, nome, contacto, menu, pedido_especial, pago_cents);

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

    db.prepare(`
      UPDATE jantares_convidados
         SET mesa_id=?, nome=?, contacto=?, menu=?, pedido_especial=?, pago_cents=?, presenca=?
       WHERE id=? AND jantar_id=?
    `).run(mesa_id, nome, contacto, menu, pedido_especial, pago_cents, presenca, req.params.cid, req.params.jid);

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
   IMPRIMIR MESAS (apenas mesas; sem layout)
   ========================================================= */
router.get('/jantares/:id/mesas/print', requireAuth, (req, res, next) => {
  try {
    const j = getJantarOr404(req.params.id);
    const settings = getSettings();

    // Mesas + convidados por mesa
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

    // Distribui convidados por mesa
    const byMesa = new Map();
    for (const m of mesas) byMesa.set(m.id, []);
    for (const c of convidadosPorJantar) {
      if (c.mesa_id && byMesa.has(c.mesa_id)) byMesa.get(c.mesa_id).push(c);
    }

    // Prepara estrutura com contagem por menu
    const mesasOut = mesas.map(m => {
      const lst = byMesa.get(m.id) || [];
      const contagem = { normal:0, vegetariano:0, sem_gluten:0, infantil:0, outro:0 };
      for (const c of lst) {
        contagem[c.menu] = (contagem[c.menu] || 0) + 1;
      }
      return { ...m, convidados: lst, contagem };
    });

    // Convidados sem mesa
    const semMesa = convidadosPorJantar
      .filter(c => !c.mesa_id)
      .map(c => ({
        convidado_nome: c.nome,
        menu: c.menu,
        pedido_especial: c.pedido_especial,
        pago_cents: c.pago_cents,
      }));

    // Totais por menu (global)
    const totais = { normal:0, vegetariano:0, sem_gluten:0, infantil:0, outro:0 };
    for (const m of mesasOut) {
      for (const k of Object.keys(totais)) totais[k] += (m.contagem[k] || 0);
    }
    for (const s of semMesa) totais[s.menu] = (totais[s.menu] || 0) + 1;

    res.render('jantares_mesas_print', {
      layout: false,        // MUITO IMPORTANTE: sem layout.ejs
      minimal: true,        // imprime só as mesas (sem cabeçalho/toolbar)
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
