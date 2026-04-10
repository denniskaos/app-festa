const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/;

export function validatePasswordStrength(password) {
  const value = String(password || '');
  if (!STRONG_PASSWORD_REGEX.test(value)) {
    return {
      ok: false,
      message:
        'A palavra-passe deve ter pelo menos 10 caracteres, com maiúsculas, minúsculas, número e símbolo.',
    };
  }
  return { ok: true, message: null };
}

export function sameOriginGuard(req, { strict = false } = {}) {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').toLowerCase();
  const origin = String(req.get('origin') || '').toLowerCase();
  const referer = String(req.get('referer') || '').toLowerCase();
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();

  const matches = (value) => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.host.toLowerCase() === host;
    } catch {
      return false;
    }
  };

  if (fetchSite === 'cross-site') return false;
  if (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') return true;

  if (matches(origin) || matches(referer)) return true;
  if (!origin && !referer) {
    // Alguns browsers/proxies não enviam Origin/Referer em formulários.
    return !strict;
  }

  // Fallback permissivo: evita falsos positivos em ambientes com proxy/domínio.
  // O bloqueio forte fica para casos com sinal explícito (`Sec-Fetch-Site: cross-site`).
  return true;
}
