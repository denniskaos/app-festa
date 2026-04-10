import db from '../db.js';
import { logAuthEvent } from '../lib/audit.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

db.exec(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    k TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start_ms INTEGER NOT NULL
  )
`);

function keyFor(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${email}`;
}

export function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = keyFor(req);
  db.prepare('DELETE FROM login_attempts WHERE window_start_ms < ?').run(now - WINDOW_MS * 12);

  const row = db.prepare('SELECT count, window_start_ms FROM login_attempts WHERE k=?').get(key);
  let count = 1;
  let windowStart = now;

  if (row) {
    const elapsed = now - Number(row.window_start_ms || 0);
    if (elapsed <= WINDOW_MS) {
      count = Number(row.count || 0) + 1;
      windowStart = Number(row.window_start_ms || now);
    }
  }
  db.prepare(`
    INSERT INTO login_attempts (k, count, window_start_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET
      count = excluded.count,
      window_start_ms = excluded.window_start_ms
  `).run(key, count, windowStart);

  if (count > MAX_ATTEMPTS) {
    const waitSec = Math.ceil((WINDOW_MS - (now - windowStart)) / 1000);
    logAuthEvent({
      event: 'login_rate_limited',
      email: String(req.body?.email || '').trim().toLowerCase(),
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      meta: { waitSec, count },
    });
    return res
      .status(429)
      .render('login', { title: 'Entrar', error: `Muitas tentativas. Tenta novamente em ${waitSec}s.` });
  }
  return next();
}

export function clearLoginRateLimit(req) {
  db.prepare('DELETE FROM login_attempts WHERE k=?').run(keyFor(req));
}
<<<<<<< codex/identify-application-improvement-areas-ohbtvp

export function clearLoginRateLimitByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return 0;
  const info = db.prepare(`
    DELETE FROM login_attempts
    WHERE substr(k, instr(k, ':') + 1) = ?
  `).run(normalized);
  return Number(info.changes || 0);
}
=======
>>>>>>> main
