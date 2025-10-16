// middleware/requireAuth.js
export function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
export function requireAdmin(req,res,next){if(req.session?.user?.role==='admin')return next();res.status(403).send('Acesso negado');}