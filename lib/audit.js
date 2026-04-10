import db from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dt TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    event TEXT NOT NULL,
    email TEXT,
    ip TEXT,
    meta TEXT
  )
`);

export function logAuthEvent({ event, email = null, ip = null, meta = null }) {
  db.prepare(`
    INSERT INTO auth_audit (event, email, ip, meta)
    VALUES (?, ?, ?, ?)
  `).run(event, email, ip, meta ? JSON.stringify(meta) : null);
}

