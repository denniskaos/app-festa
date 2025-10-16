import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => (v==null?'':String(v).replaceAll('"','""'));
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => `"${esc(r[h])}"`).join(','));
  }
  return lines.join('\n');
}

router.get('/backup', requireAuth, (req, res) => {
  res.render('backup', { title:'Backup/Export', user: req.session.user });
});

router.get('/export/db', requireAuth, (req, res) => {
  res.download('./data/festa.db', 'festa.db');
});

router.get('/export/:table.csv', requireAuth, (req, res) => {
  const table = req.params.table.replace('.csv','');
  const valid = ['events','orcamento','movimentos','patrocinadores','jantares','jantar_inscritos','settings'];
  if (!valid.includes(table)) return res.status(400).send('Tabela inválida');
  const map = { orcamento: 'categorias' };
  const realTable = map[table] || table;
  const rows = db.prepare(`SELECT * FROM ${realTable}`).all();
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  // Nome do ficheiro deve respeitar o alias pedido pelo utilizador
  res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
  res.send(toCSV(rows));
});

export default router;