import { Router } from 'express';
import db, { cents, euros } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/* Produtos */
router.get('/produtos', requireAuth, (req, res) => {
  const produtos = db.prepare('SELECT * FROM products ORDER BY active DESC, name').all();
  res.render('produtos', { title: 'Produtos', user: req.session.user, produtos, euros });
});
router.get('/produtos/new', requireAuth, (req, res) => {
  res.render('produtos_form', { title: 'Novo Produto', user: req.session.user, p: null });
});
router.post('/produtos', requireAuth, (req, res) => {
  const { name, price, unit, active } = req.body;
  db.prepare('INSERT INTO products (name, price_cents, unit, active) VALUES (?,?,?,?)')
    .run(name, cents(price), unit || 'un', active ? 1 : 0);
  res.redirect('/produtos');
});
router.get('/produtos/:id/edit', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).send('Produto não encontrado');
  res.render('produtos_form', { title: 'Editar Produto', user: req.session.user, p });
});
router.post('/produtos/:id', requireAuth, (req, res) => {
  const { name, price, unit, active } = req.body;
  db.prepare('UPDATE products SET name=?, price_cents=?, unit=?, active=? WHERE id=?')
    .run(name, cents(price), unit || 'un', active ? 1 : 0, req.params.id);
  res.redirect('/produtos');
});
router.post('/produtos/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.redirect('/produtos');
});

/* Stock movimentos */
router.get('/stock', requireAuth, (req, res) => {
  const movs = db.prepare(`SELECT s.*, p.name AS product FROM stock_mov s JOIN products p ON p.id=s.product_id ORDER BY s.id DESC`).all();
  const produtos = db.prepare('SELECT id, name FROM products ORDER BY name').all();
  res.render('stock', { title: 'Movimentos de Stock', user: req.session.user, movs, produtos });
});
router.post('/stock', requireAuth, (req, res) => {
  const { product_id, qty, type, note } = req.body;
  db.prepare('INSERT INTO stock_mov (product_id, qty, type, note) VALUES (?,?,?,?)')
    .run(product_id, parseInt(qty,10), type, note || null);
  res.redirect('/stock');
});

/* Vendas */
router.get('/vendas', requireAuth, (req, res) => {
  const vendas = db.prepare('SELECT * FROM vendas ORDER BY id DESC').all();
  res.render('vendas', { title: 'Vendas', user: req.session.user, vendas, euros });
});
router.get('/vendas/new', requireAuth, (req, res) => {
  const produtos = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.render('vendas_form', { title: 'Nova Venda', user: req.session.user, produtos });
});
router.post('/vendas', requireAuth, (req, res) => {
  const { itens } = req.body; // itens em JSON: [{product_id, qty, price}]
  let data;
  try { data = JSON.parse(itens); } catch { data = []; }
  const insVenda = db.prepare('INSERT INTO vendas (total_cents, note) VALUES (?,?)');
  const insItem = db.prepare('INSERT INTO venda_itens (venda_id, product_id, qty, price_cents) VALUES (?,?,?,?)');
  const stockOut = db.prepare('INSERT INTO stock_mov (product_id, qty, type, note) VALUES (?,?,?,?)');
  let total = 0;
  const tx = db.transaction(() => {
    const vendaId = insVenda.run(0, null).lastInsertRowid;
    for (const it of data) {
      const pc = Math.round(+it.price * 100);
      total += it.qty * pc;
      insItem.run(vendaId, it.product_id, it.qty, pc);
      stockOut.run(it.product_id, it.qty, 'out', `Venda #${vendaId}`);
    }
    db.prepare('UPDATE vendas SET total_cents=? WHERE id=?').run(total, vendaId);
    return vendaId;
  });
  const id = tx();
  res.redirect('/vendas/' + id);
});
router.get('/vendas/:id', requireAuth, (req, res) => {
  const v = db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id);
  const itens = db.prepare(`SELECT vi.*, p.name FROM venda_itens vi JOIN products p ON p.id=vi.product_id WHERE venda_id=?`).all(req.params.id);
  res.render('vendas_show', { title: 'Venda #' + req.params.id, user: req.session.user, v, itens, euros });
});

export default router;