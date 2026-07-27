// routes/peditorios.js
import { Router } from 'express';
import db, { cents } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// LISTAR
router.get('/peditorios', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      id, COALESCE(nome_pessoa,'') AS nome_pessoa, local, equipa,
      COALESCE(valor_prometido_cents, valor_cents, 0) AS valor_prometido_cents,
      COALESCE(valor_entregue_cents, valor_cents, 0) AS valor_entregue_cents
    FROM peditorios
    ORDER BY id DESC
  `).all();

  const total_valor_prometido_cents = rows.reduce((s, r) => s + (r.valor_prometido_cents || 0), 0);
  const total_valor_entregue_cents = rows.reduce((s, r) => s + (r.valor_entregue_cents || 0), 0);
  const total_valor_falta_cents = total_valor_prometido_cents - total_valor_entregue_cents;
  const gruposPorNome = new Map();

  // Percorre do registo mais antigo para o mais recente para conservar a grafia
  // original do nome do grupo quando existem diferenças apenas de maiúsculas.
  for (const row of [...rows].reverse()) {
    const nome = String(row.equipa || '').trim() || 'Sem grupo';
    const chave = nome.toLocaleLowerCase('pt-PT');
    const grupo = gruposPorNome.get(chave) || {
      nome,
      valor_prometido_cents: 0,
      valor_entregue_cents: 0,
      valor_falta_cents: 0
    };

    grupo.valor_prometido_cents += row.valor_prometido_cents || 0;
    grupo.valor_entregue_cents += row.valor_entregue_cents || 0;
    grupo.valor_falta_cents = grupo.valor_prometido_cents - grupo.valor_entregue_cents;
    gruposPorNome.set(chave, grupo);
  }

  const grupos = [...gruposPorNome.values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-PT', { sensitivity: 'base' }));

  res.render('peditorios', {
    title: 'Peditórios',
    user: req.session.user,
    itens: rows,
    grupos,
    total_valor_prometido_cents,
    total_valor_entregue_cents,
    total_valor_falta_cents
  });
});

// NOVO (página)
router.get('/peditorios/new', requireAuth, (req, res) => {
  res.render('peditorios_new', {
    title: 'Novo Peditório',
    user: req.session.user
  });
});

// CRIAR
router.post('/peditorios', requireAuth, (req, res) => {
  const nome_pessoa = (req.body.nome_pessoa || '').trim() || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_prometido_cents = cents(req.body.valor_prometido || 0);
  const valor_entregue_cents = cents(req.body.valor_entregue || 0);

  db.prepare(`
    INSERT INTO peditorios (nome_pessoa, local, equipa, valor_cents, valor_prometido_cents, valor_entregue_cents)
    VALUES (?,?,?,?,?,?)
  `).run(nome_pessoa, local, equipa, valor_entregue_cents, valor_prometido_cents, valor_entregue_cents);

  res.redirect('/peditorios');
});

// EDITAR (página)
router.get('/peditorios/:id/edit', requireAuth, (req, res) => {
  const p = db.prepare(`
    SELECT
      id,
      COALESCE(nome_pessoa,'') AS nome_pessoa,
      COALESCE(local,'') AS local,
      COALESCE(equipa,'') AS equipa,
      COALESCE(valor_prometido_cents, valor_cents, 0) AS valor_prometido_cents,
      COALESCE(valor_entregue_cents, valor_cents, 0) AS valor_entregue_cents
    FROM peditorios
    WHERE id=?
  `).get(req.params.id);
  if (!p) return res.status(404).type('text').send('Peditório não encontrado');
  res.render('peditorios_edit', { title: 'Editar Peditório', user: req.session.user, p });
});

// EDITAR
router.post('/peditorios/:id/update', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const nome_pessoa = (req.body.nome_pessoa || '').trim() || null;
  const local  = (req.body.local || '').trim() || null;
  const equipa = (req.body.equipa || '').trim() || null;
  const valor_prometido_cents = cents(req.body.valor_prometido || 0);
  const valor_entregue_cents = cents(req.body.valor_entregue || 0);

  db.prepare(`
    UPDATE peditorios
       SET nome_pessoa=?, local=?, equipa=?, valor_cents=?, valor_prometido_cents=?, valor_entregue_cents=?
     WHERE id=?
  `).run(nome_pessoa, local, equipa, valor_entregue_cents, valor_prometido_cents, valor_entregue_cents, id);

  res.redirect('/peditorios');
});

// APAGAR
router.post('/peditorios/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM peditorios WHERE id=?').run(req.params.id);
  res.redirect('/peditorios');
});

export default router;
