// middleware/roles.js

/* Pequenos helpers */
function getUser(req) {
  return req?.session?.user || null;
}
function normPath(p) {
  return String(p || '').toLowerCase();
}
function hasRole(user, roles) {
  if (!user) return false;
  if (Array.isArray(roles)) return roles.includes(user.role);
  return user.role === roles;
}

/**
 * requireRole(roles)
 * - Impede acesso se o utilizador não tiver um dos papéis exigidos
 * - Redireciona para /login se não estiver autenticado
 */
export function requireRole(roles) {
  return (req, res, next) => {
    const u = getUser(req);
    if (!u) return res.redirect('/login');
    if (!hasRole(u, roles)) return res.status(403).send('Sem permissões.');
    next();
  };
}

/**
 * requireNotViewer
 * - Permite apenas users que NÃO sejam viewer (ex.: editor/admin)
 */
export function requireNotViewer(req, res, next) {
  const u = getUser(req);
  if (!u) return res.redirect('/login');
  if (u.role === 'viewer') return res.status(403).send('Sem permissões.');
  next();
}

/**
 * requireAdmin
 * - Apenas administradores
 */
export function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin') return res.status(403).send('Apenas administradores.');
  next();
}

/**
 * readOnlyForViewers
 * - Bloqueia alterações para contas "viewer"
 * - Exceções seguras (permitir POST de logout / atualização do próprio perfil)
 * - Também bloqueia endpoints perigosos acionados por GET contendo "/delete"
 */
export function readOnlyForViewers(req, res, next) {
  const u = getUser(req);
  if (!u) return next(); // sem sessão → deixa seguir; outras guards tratam do login

  const method = String(req.method || 'GET').toUpperCase();
  const path = normPath(req.path || req.url);

  // Exceções seguras de POST para viewer (ajusta aqui se for preciso)
  const allowedForViewerPost = [
    '/logout',
    '/definicoes/perfil', // ex.: alterar nome próprio/pass do próprio utilizador
  ];

  // Hard-stop: não permitir "delete" por GET (defensivo)
  if (method === 'GET' && /\/delete(\b|\/)/i.test(path) && u.role === 'viewer') {
    return res.status(403).send('Conta de leitura: não pode alterar dados.');
  }

  // Só leitura para viewer em métodos de escrita, salvo exceções seguras
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (u.role === 'viewer' && isWrite) {
    const allowed = allowedForViewerPost.some(p => path.startsWith(p));
    if (!allowed) {
      return res.status(403).send('Conta de leitura: não pode alterar dados.');
    }
  }

  next();
}

/* (Opcional) Helpers semânticos para usares noutros ficheiros, se quiseres */
export function isViewer(req) {
  return getUser(req)?.role === 'viewer';
}
export function isAdmin(req) {
  return getUser(req)?.role === 'admin';
}
