const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPTS = new Map();

function keyFor(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${email}`;
}

function cleanup(now) {
  for (const [k, v] of ATTEMPTS.entries()) {
    if (now - v.firstSeen > WINDOW_MS) ATTEMPTS.delete(k);
  }
}

export function loginRateLimit(req, res, next) {
  const now = Date.now();
  cleanup(now);
  const key = keyFor(req);
  const entry = ATTEMPTS.get(key) || { count: 0, firstSeen: now };
  if (now - entry.firstSeen > WINDOW_MS) {
    entry.count = 0;
    entry.firstSeen = now;
  }
  entry.count += 1;
  ATTEMPTS.set(key, entry);

  if (entry.count > MAX_ATTEMPTS) {
    const waitSec = Math.ceil((WINDOW_MS - (now - entry.firstSeen)) / 1000);
    return res
      .status(429)
      .render('login', { title: 'Entrar', error: `Muitas tentativas. Tenta novamente em ${waitSec}s.` });
  }
  return next();
}

export function clearLoginRateLimit(req) {
  ATTEMPTS.delete(keyFor(req));
}

