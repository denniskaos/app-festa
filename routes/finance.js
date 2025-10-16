// routes/finance.js  // v-clean-rodizio-pt-2025-10-16
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

console.log('[finance.js] versão: v-clean-rodizio-pt-2025-10-16');

const router = Router();

/* ================= ORÇAMENTO ================= */
router.get('/orcamento', requireAuth, (req, res, next) => {
  try {
    const linhas = db.prepare(`
      SELECT * FROM orcamento_servicos
      ORDER BY COALESCE(dt,'9999-99-99'), id
    `).all();
    const total = linhas.reduce((acc, r) => acc + (r.valor_cents || 0), 0);
    res.render('orcamento', { title:'Orçamento', user:req.session.user, linhas, total, euros });
  } catch (e) { next(e); }
});
router.post('/orcamento', requireAuth, (req, res, next) => {
  try {
    const { dt, descr, valor, notas } = req.body;
    db.prepare(`INSERT INTO orcamento_servicos (dt, descr, valor_cents, notas) VALUES (?,?,?,?)`)
      .run(dt || null, descr, cents(valor || 0), notas || null);
    res.redirect('/orcamento');
  } catch (e) { next(e); }
});
router.post('/orcamento/:id', requireAuth, (req, res, next) => {
  try {
    const { dt, descr, valor, notas } = req.body;
    db.prepare(`UPDATE orcamento_servicos SET dt=?, descr=?, valor_cents=?, notas=? WHERE id=?`)
      .run(dt || null, descr, cents(valor || 0), notas || null, req.params.id);
    res.redirect('/orcamento');
  } catch (e) { next(e); }
});
router.post('/orcamento/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare('DELETE FROM orcamento_servicos WHERE id=?').run(req.params.id);
    res.redirect('/orcamento');
  } catch (e) { next(e); }
});

/* ================= MOVIMENTOS ================= */
router.get('/movimentos', requireAuth, (req, res, next) => {
  try {
    const movs = db.prepare(`
      SELECT m.*, c.name as categoria, c.type
      FROM movimentos m
      JOIN categorias c ON c.id = m.categoria_id
      ORDER BY date(dt) DESC, id DESC
    `).all();

    const sumRec = db.prepare(`
      SELECT IFNULL(SUM(valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='receita'
    `).get().s;

    const sumDesp = db.prepare(`
      SELECT IFNULL(SUM(valor_cents),0) AS s
      FROM movimentos m JOIN categorias c ON c.id=m.categoria_id
      WHERE c.type='despesa'
    `).get().s;

    res.render('movimentos', { title:'Movimentos', user:req.session.user, movs, sumRec, sumDesp, euros });
  } catch (e) { next(e); }
});

router.post('/movimentos', requireAuth, (req, res, next) => {
  try {
    const { dt, type, descr, valor } = req.body;

    // garante a categoria "Genérico" do tipo certo
    let cat = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?').get(type, 'Genérico');
    if (!cat) {
      db.prepare('INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)')
        .run('Genérico', type);
      cat = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?').get(type, 'Genérico');
    }

    db.prepare('INSERT INTO movimentos (dt, categoria_id, descr, valor_cents) VALUES (?,?,?,?)')
      .run(dt || null, cat.id, descr || null, cents(valor || 0));
    res.redirect('/movimentos');
  } catch (e) { next(e); }
});

router.get('/movimentos/:id/edit', requireAuth, (req, res, next) => {
  try {
    const m = db.prepare(`
      SELECT m.*, c.type
      FROM movimentos m
      JOIN categorias c ON c.id = m.categoria_id
      WHERE m.id = ?
    `).get(req.params.id);
    if (!m) return res.status(404).send('Movimento não encontrado');
    res.render('movimentos_edit', { title:'Editar Movimento', user:req.session.user, m });
  } catch (e) { next(e); }
});

router.post('/movimentos/:id', requireAuth, (req, res, next) => {
  try {
    const { dt, type, descr, valor } = req.body;

    let cat = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?').get(type, 'Genérico');
    if (!cat) {
      db.prepare('INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)')
        .run('Genérico', type);
      cat = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?').get(type, 'Genérico');
    }

    db.prepare('UPDATE movimentos SET dt=?, categoria_id=?, descr=?, valor_cents=? WHERE id=?')
      .run(dt || null, cat.id, descr || null, cents(valor || 0), req.params.id);
    res.redirect('/movimentos');
  } catch (e) { next(e); }
});

router.post('/movimentos/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare('DELETE FROM movimentos WHERE id=?').run(req.params.id);
    res.redirect('/movimentos');
  } catch (e) { next(e); }
});

/* ================= PATROCINADORES ================= */
router.get('/patrocinadores', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT id,
             COALESCE(name,'')                 AS name,
             COALESCE(contacto,'')             AS contacto,
             COALESCE(tipo,'')                 AS tipo,
             COALESCE(valor_prometido_cents,0) AS valor_prometido_cents,
             COALESCE(valor_entregue_cents,0)  AS valor_entregue_cents,
             COALESCE(observ,'')               AS observ
      FROM patrocinadores
      ORDER BY name COLLATE NOCASE
    `).all();

    const totalProm = rows.reduce((a, r) => a + (r.valor_prometido_cents || 0), 0);
    const totalEnt  = rows.reduce((a, r) => a + (r.valor_entregue_cents  || 0), 0);

    res.render('patrocinadores', { pats: rows, totalProm, totalEnt, euros, user: req.session.user });
  } catch (e) { next(e); }
});

router.get('/patrocinadores/new', requireAuth, (_req, res) => {
  res.render('patrocinadores_new', { user: _req.session.user });
});

router.post('/patrocinadores', requireAuth, (req, res, next) => {
  try {
    const { name, contacto, tipo, valor_prometido, valor_entregue, observ } = req.body;
    db.prepare(`
      INSERT INTO patrocinadores
        (name, contacto, tipo, valor_prometido_cents, valor_entregue_cents, observ)
      VALUES (?,?,?,?,?,?)
    `).run(
      (name || '').trim(),
      (contacto || '').trim(),
      (tipo || '').trim(),
      cents(valor_prometido),
      cents(valor_entregue),
      observ || ''
    );
    res.redirect('/patrocinadores');
  } catch (e) { next(e); }
});

router.get('/patrocinadores/:id/edit', requireAuth, (req, res, next) => {
  try {
    const p = db.prepare(`
      SELECT id, name, contacto, tipo,
             COALESCE(valor_prometido_cents,0) AS valor_prometido_cents,
             COALESCE(valor_entregue_cents,0)  AS valor_entregue_cents,
             COALESCE(observ,'')               AS observ
      FROM patrocinadores WHERE id=?
    `).get(req.params.id);
    if (!p) return res.status(404).type('text').send('Não encontrado');
    res.render('patrocinadores_edit', { p, euros, user: req.session.user });
  } catch (e) { next(e); }
});

router.post('/patrocinadores/:id/update', requireAuth, (req, res, next) => {
  try {
    const { name, contacto, tipo, valor_prometido, valor_entregue, observ } = req.body;
    db.prepare(`
      UPDATE patrocinadores
         SET name=?, contacto=?, tipo=?, valor_prometido_cents=?, valor_entregue_cents=?, observ=?
       WHERE id=?
    `).run(
      (name || '').trim(),
      (contacto || '').trim(),
      (tipo || '').trim(),
      cents(valor_prometido),
      cents(valor_entregue),
      observ || '',
      req.params.id
    );
    res.redirect('/patrocinadores');
  } catch (e) { next(e); }
});

router.post('/patrocinadores/:id/delete', requireAuth, (req, res, next) => {
  try {
    db.prepare(`DELETE FROM patrocinadores WHERE id=?`).run(req.params.id);
    res.redirect('/patrocinadores');
  } catch (e) { next(e); }
});

export default router;
