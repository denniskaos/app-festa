import session from 'express-session';
import Database from 'better-sqlite3';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function sessionExpiry(sess) {
  const maxAge = Number(sess?.cookie?.maxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;

  const expires = new Date(sess?.cookie?.expires || 0).getTime();
  return Number.isFinite(expires) && expires > Date.now() ? expires : Date.now() + ONE_DAY_MS;
}

export class BetterSQLiteSessionStore extends session.Store {
  constructor({ filename }) {
    super();
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // Mantém o mesmo esquema usado anteriormente por connect-sqlite3.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid PRIMARY KEY,
        expired,
        sess
      )
    `);

    this.statements = {
      get: this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired >= ?'),
      set: this.db.prepare('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)'),
      destroy: this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
      all: this.db.prepare('SELECT sess FROM sessions WHERE expired >= ?'),
      length: this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expired >= ?'),
      clear: this.db.prepare('DELETE FROM sessions'),
      touch: this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ? AND expired >= ?'),
      cleanup: this.db.prepare('DELETE FROM sessions WHERE expired < ?'),
    };

    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), ONE_DAY_MS);
    this.cleanupTimer.unref();
  }

  finish(callback, operation) {
    try {
      const value = operation();
      if (typeof callback === 'function') callback(null, value);
    } catch (error) {
      if (typeof callback === 'function') callback(error);
      else this.emit('error', error);
    }
  }

  get(sid, callback) {
    this.finish(callback, () => {
      const row = this.statements.get.get(sid, Date.now());
      return row ? JSON.parse(row.sess) : null;
    });
  }

  set(sid, sess, callback) {
    this.finish(callback, () => {
      this.statements.set.run(sid, sessionExpiry(sess), JSON.stringify(sess));
    });
  }

  destroy(sid, callback) {
    this.finish(callback, () => this.statements.destroy.run(sid));
  }

  all(callback) {
    this.finish(callback, () => this.statements.all.all(Date.now()).map((row) => JSON.parse(row.sess)));
  }

  length(callback) {
    this.finish(callback, () => this.statements.length.get(Date.now()).count);
  }

  clear(callback) {
    this.finish(callback, () => this.statements.clear.run());
  }

  touch(sid, sess, callback) {
    this.finish(callback, () => this.statements.touch.run(sessionExpiry(sess), sid, Date.now()));
  }

  cleanup() {
    this.finish(null, () => this.statements.cleanup.run(Date.now()));
  }
}
