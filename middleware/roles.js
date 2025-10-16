/// middleware/roles.js
export function requireRole(roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    const ok = Array.isArray(roles) ? roles.includes(u.role) : u.role === roles;
    if (!ok) return res.status(403).send('Sem permissões.');
    next();
  };
}

// Bloqueia escrita para contas viewer (com pequenas exceções seguras)
export function readOnlyForViewers(req, res, next) {
  const u = req.session.user;
  if (!u) return next();

  const method = req.method.toUpperCase();
  const path = req.path || req.url;

  // exceções seguras
  const allowedForViewerPost = ['/logout', '/definicoes/perfil'];

  // bloquear “delete” acionados por GET (não deviam existir, mas por via das dúvidas)
  if (method === 'GET' && /\/delete(\b|\/)/i.test(path) && u.role === 'viewer') {
    return res.status(403).send('Conta de leitura: não pode alterar dados.');
  }

  if (u.role === 'viewer' && ['POST','PUT','PATCH','DELETE'].includes(method)) {
    if (!allowedForViewerPost.some(p => path.startsWith(p))) {
      return res.status(403).send('Conta de leitura: não pode alterar dados.');
    }
  }
  next();
}
