// routes/finance.js
import { Router } from 'express';
import db, { euros, cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

function getInt(sql) {
  try {
    const row = db.prepare(sql).get();
    return (row && (row.n ?? row.total ?? 0)) || 0;
  } catch {
    return 0;
  }
}

function genericCategoryId(type) {
  let category = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?')
    .get(type, 'Genérico');
  if (!category) {
    db.prepare('INSERT OR IGNORE INTO categorias (name, type, planned_cents) VALUES (?,?,0)')
      .run('Genérico', type);
    category = db.prepare('SELECT id FROM categorias WHERE type=? AND name=?')
      .get(type, 'Genérico');
  }
  return category.id;
}

function todayInLisbon() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const GENERIC_MATCH_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'despesa', 'do', 'dos', 'e', 'em',
  'festa', 'liquidacao', 'liquidar', 'na', 'nas', 'no', 'nos', 'o', 'orcamento', 'os',
  'paga', 'pago', 'pagamento', 'para', 'parcela', 'parcelas', 'por', 'sem', 'servico',
  'servicos', 'um', 'uma', 'umas', 'uns',
]);

function singularizeMatchWord(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('oes')) return `${word.slice(0, -3)}ao`;
  if (word.endsWith('aes')) return `${word.slice(0, -3)}ao`;
  if (word.endsWith('ais')) return `${word.slice(0, -3)}al`;
  if (word.endsWith('eis')) return `${word.slice(0, -3)}el`;
  if (word.endsWith('ois')) return `${word.slice(0, -3)}ol`;
  if (word.endsWith('uis')) return `${word.slice(0, -3)}ul`;
  if (word.endsWith('ns')) return `${word.slice(0, -2)}m`;
  if (word.endsWith('es') && /[rsz]es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function normalizeMatchText(value) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized
    .split(' ')
    .filter(Boolean)
    .map(singularizeMatchWord)
    .join(' ');
}

function meaningfulWords(value) {
  return normalizeMatchText(value)
    .split(' ')
    .filter((word) => word.length >= 2 && !GENERIC_MATCH_WORDS.has(word));
}

function movementMatchScore(line, movement) {
  if (Number(line.valor_cents || 0) !== Number(movement.valor_cents || 0)) return -1;

  const movementText = normalizeMatchText(movement.descr);
  const lineDescription = normalizeMatchText(line.descr);
  const lineNotes = normalizeMatchText(line.notas);
  if (!movementText) return -1;

  if (lineDescription && movementText === lineDescription) return 1000;
  if (lineNotes && movementText === lineNotes) return 950;

  for (const candidate of [lineDescription, lineNotes]) {
    if (candidate.length < 4) continue;
    if (movementText.includes(candidate) || candidate.includes(movementText)) {
      return 800 + Math.min(candidate.length, movementText.length);
    }
  }

  const lineWords = new Set([
    ...meaningfulWords(line.descr),
    ...meaningfulWords(line.notas),
  ]);
  const movementWords = new Set(meaningfulWords(movement.descr));
  const sharedWords = [...lineWords].filter((word) => movementWords.has(word));
  if (sharedWords.length >= 2) {
    return 400 + sharedWords.reduce((sum, word) => sum + word.length, 0);
  }
  if (sharedWords.length === 1 && sharedWords[0].length >= 4) {
    return 200 + sharedWords[0].length;
  }
  return -1;
}

const reconcileBudgetMovements = db.transaction(() => {
  const lines = db.prepare(`
    SELECT id,
           COALESCE(descr, '') AS descr,
           COALESCE(notas, '') AS notas,
           COALESCE(valor_cents, 0) AS valor_cents
    FROM orcamento_servicos
    WHERE movimento_id IS NULL
    ORDER BY id
  `).all();
  if (!lines.length) return 0;

  const movements = db.prepare(`
    SELECT m.id, m.descr, COALESCE(m.valor_cents, 0) AS valor_cents
    FROM movimentos m
    JOIN categorias c ON c.id = m.categoria_id
    LEFT JOIN orcamento_servicos o ON o.movimento_id = m.id
    WHERE c.type = 'despesa'
      AND o.id IS NULL
    ORDER BY COALESCE(date(m.dt), '9999-99-99'), m.id
  `).all();

  const link = db.prepare(`
    UPDATE orcamento_servicos
    SET movimento_id = ?
    WHERE id = ? AND movimento_id IS NULL
  `);
  let linked = 0;
  const usedMovementIds = new Set();
  for (const line of lines) {
    let bestMovement = null;
    let bestScore = -1;
    for (const movement of movements) {
      if (usedMovementIds.has(movement.id)) continue;
      const score = movementMatchScore(line, movement);
      if (score <= bestScore) continue;
      bestMovement = movement;
      bestScore = score;
    }
    if (!bestMovement || bestScore < 0) continue;
    const result = link.run(bestMovement.id, line.id);
    if (result.changes) usedMovementIds.add(bestMovement.id);
    linked += result.changes;
  }
  return linked;
});

const settleBudgetLine = db.transaction((id) => {
  const line = db.prepare(`
    SELECT o.id,
           COALESCE(o.dt, '') AS dt,
           COALESCE(o.descr, '') AS descr,
           COALESCE(o.valor_cents, 0) AS valor_cents,
           o.movimento_id,
           m.id AS movimento_existente
    FROM orcamento_servicos o
    LEFT JOIN movimentos m ON m.id = o.movimento_id
    WHERE o.id = ?
  `).get(id);

  if (!line) return { status: 'not-found' };
  if (line.movimento_existente) return { status: 'already-settled' };

  if (line.movimento_id) {
    db.prepare('UPDATE orcamento_servicos SET movimento_id=NULL WHERE id=?').run(id);
  }

  const movement = db.prepare(`
    INSERT INTO movimentos (dt, categoria_id, descr, valor_cents)
    VALUES (?, ?, ?, ?)
  `).run(
    todayInLisbon(),
    genericCategoryId('despesa'),
    line.descr || 'Parcela do orçamento',
    line.valor_cents,
  );

  db.prepare('UPDATE orcamento_servicos SET movimento_id=? WHERE id=?')
    .run(Number(movement.lastInsertRowid), id);

  return { status: 'settled', movementId: Number(movement.lastInsertRowid) };
});

/* ================= ORÇAMENTO ================= */
router.get('/orcamento', requireAuth, (req, res, next) => {
  try {
    reconcileBudgetMovements();
    const linhas = db.prepare(`
      SELECT o.*,
             CASE WHEN m.id IS NULL THEN 0 ELSE 1 END AS liquidado
      FROM orcamento_servicos o
      LEFT JOIN movimentos m ON m.id = o.movimento_id
      ORDER BY COALESCE(o.dt,'9999-99-99'), o.id
    `).all();
    const total = linhas.reduce((acc, r) => acc + (r.valor_cents || 0), 0);
    const totalLiquidado = linhas.reduce(
      (acc, r) => acc + (r.liquidado ? (r.valor_cents || 0) : 0),
      0,
    );

    const sumRec = getInt(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS n
      FROM movimentos m
      JOIN categorias c ON c.id = m.categoria_id
      WHERE c.type = 'receita'
    `);
    const sumDesp = getInt(`
      SELECT COALESCE(SUM(m.valor_cents),0) AS n
      FROM movimentos m
      JOIN categorias c ON c.id = m.categoria_id
      WHERE c.type = 'despesa'
    `);
    const saldoMov = sumRec - sumDesp;
    const totalPatrocinadores = getInt(`
      SELECT COALESCE(SUM(
        COALESCE(valor_entregue_cents,
                 CASE WHEN valor_cents IS NOT NULL AND valor_cents > 0 THEN valor_cents ELSE 0 END)
      ),0) AS n
      FROM patrocinadores
    `);
    const totalPeditorios = getInt(`
      SELECT COALESCE(SUM(
        COALESCE(valor_entregue_cents,
                 CASE WHEN valor_cents IS NOT NULL THEN valor_cents ELSE 0 END)
      ),0) AS n
      FROM peditorios
    `);
    const totalLeiloes = getInt(`
      SELECT COALESCE(SUM(valor_recebido_cents), 0) AS n
      FROM leiloes
      WHERE numero BETWEEN 1 AND 4
    `);
    const totalLugaresPago = getInt(`
      SELECT COALESCE(SUM(valor_pago_cents), 0) AS n
      FROM vendas_lugares
    `);
    const saldoFinal = totalPatrocinadores
      + totalPeditorios
      + totalLeiloes
      + totalLugaresPago
      + saldoMov;
    const saldoEmFalta = Math.max(total - totalLiquidado, 0);

    res.render('orcamento', {
      title:'Orçamento',
      user:req.session.user,
      linhas,
      total,
      saldoFinal,
      saldoEmFalta,
      msg: String(req.query.msg || '').slice(0, 240) || null,
      err: String(req.query.err || '').slice(0, 240) || null,
      euros
    });
  } catch (e) { next(e); }
});
router.get('/orcamento/new', requireAuth, (req, res) => {
  res.render('orcamento_new', { title: 'Novo Serviço', user: req.session.user });
});
router.post('/orcamento', requireAuth, (req, res, next) => {
  try {
    const { dt, descr, valor, notas } = req.body;
    db.prepare(`INSERT INTO orcamento_servicos (dt, descr, valor_cents, notas) VALUES (?,?,?,?)`)
      .run(dt || null, descr, cents(valor || 0), notas || null);
    res.redirect('/orcamento');
  } catch (e) { next(e); }
});
router.get('/orcamento/:id/edit', requireAuth, (req, res, next) => {
  try {
    const s = db.prepare(`
      SELECT id,
             COALESCE(dt,'') AS dt,
             COALESCE(descr,'') AS descr,
             COALESCE(valor_cents,0) AS valor_cents,
             COALESCE(notas,'') AS notas
      FROM orcamento_servicos
      WHERE id=?
    `).get(req.params.id);
    if (!s) return res.status(404).type('text').send('Serviço não encontrado');
    res.render('orcamento_edit', { title: 'Editar Serviço', user: req.session.user, s, euros });
  } catch (e) { next(e); }
});
router.post('/orcamento/:id/update', requireAuth, (req, res, next) => {
  try {
    const { dt, descr, valor, notas } = req.body;
    const id = Number(req.params.id);
    const current = db.prepare('SELECT movimento_id FROM orcamento_servicos WHERE id=?').get(id);
    if (!current) return res.status(404).type('text').send('Serviço não encontrado');

    const valorCents = cents(valor || 0);
    const updateLine = db.transaction(() => {
      db.prepare(`UPDATE orcamento_servicos SET dt=?, descr=?, valor_cents=?, notas=? WHERE id=?`)
        .run(dt || null, descr, valorCents, notas || null, id);
      if (current.movimento_id) {
        db.prepare('UPDATE movimentos SET descr=?, valor_cents=? WHERE id=?')
          .run(descr || null, valorCents, current.movimento_id);
      }
    });
    updateLine();
    res.redirect('/orcamento');
  } catch (e) { next(e); }
});
router.post('/orcamento/:id/liquidar', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect(303, '/orcamento?err=' + encodeURIComponent('Parcela inválida.'));
    }

    reconcileBudgetMovements();
    const result = settleBudgetLine(id);
    if (result.status === 'not-found') {
      return res.redirect(303, '/orcamento?err=' + encodeURIComponent('Parcela não encontrada.'));
    }
    if (result.status === 'already-settled') {
      return res.redirect(303, '/orcamento?msg=' + encodeURIComponent('Esta parcela já está liquidada.'));
    }
    return res.redirect(303, '/orcamento?msg=' + encodeURIComponent(
      'Parcela liquidada e movimento de despesa criado.',
    ));
  } catch (e) { return next(e); }
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

    db.prepare('INSERT INTO movimentos (dt, categoria_id, descr, valor_cents) VALUES (?,?,?,?)')
      .run(dt || null, genericCategoryId(type), descr || null, cents(valor || 0));
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

    db.prepare('UPDATE movimentos SET dt=?, categoria_id=?, descr=?, valor_cents=? WHERE id=?')
      .run(dt || null, genericCategoryId(type), descr || null, cents(valor || 0), req.params.id);
    res.redirect('/movimentos');
  } catch (e) { next(e); }
});

router.post('/movimentos/:id/delete', requireAuth, (req, res, next) => {
  try {
    const removeMovement = db.transaction(() => {
      db.prepare('UPDATE orcamento_servicos SET movimento_id=NULL WHERE movimento_id=?')
        .run(req.params.id);
      db.prepare('DELETE FROM movimentos WHERE id=?').run(req.params.id);
    });
    removeMovement();
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
