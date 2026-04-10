import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCsrfToken, sameOriginGuard, validatePasswordStrength, verifyCsrfToken } from '../lib/security.js';

test('validatePasswordStrength accepts strong password', () => {
  const out = validatePasswordStrength('Festa2026!');
  assert.equal(out.ok, true);
});

test('validatePasswordStrength rejects weak password', () => {
  const out = validatePasswordStrength('abc123');
  assert.equal(out.ok, false);
});

test('sameOriginGuard accepts same origin header', () => {
  const req = {
    get(name) {
      const k = String(name).toLowerCase();
      if (k === 'host') return 'example.org';
      if (k === 'origin') return 'https://example.org';
      return '';
    },
  };
  assert.equal(sameOriginGuard(req, { strict: true }), true);
});

test('sameOriginGuard allows mismatched origin when fetch metadata is absent (proxy-safe fallback)', () => {
  const req = {
    get(name) {
      const k = String(name).toLowerCase();
      if (k === 'host') return 'example.org';
      if (k === 'origin') return 'https://evil.example.net';
      return '';
    },
  };
  assert.equal(sameOriginGuard(req, { strict: true }), true);
});

test('sameOriginGuard accepts request without origin/referer when fetch metadata is absent', () => {
  const req = {
    get(name) {
      const k = String(name).toLowerCase();
      if (k === 'host') return 'example.org';
      return '';
    },
  };
  assert.equal(sameOriginGuard(req, { strict: true }), false);
  assert.equal(sameOriginGuard(req, { strict: false }), true);
});

test('sameOriginGuard rejects cross-site by fetch metadata', () => {
  const req = {
    get(name) {
      const k = String(name).toLowerCase();
      if (k === 'host') return 'example.org';
      if (k === 'sec-fetch-site') return 'cross-site';
      return '';
    },
  };
  assert.equal(sameOriginGuard(req, { strict: false }), false);
});

test('ensureCsrfToken creates and reuses session token', () => {
  const req = { session: {} };
  const a = ensureCsrfToken(req);
  const b = ensureCsrfToken(req);
  assert.ok(a);
  assert.equal(a, b);
});

test('verifyCsrfToken validates matching token from body', () => {
  const req = {
    session: { csrfToken: 'abc123' },
    body: { _csrf: 'abc123' },
    get() { return ''; },
  };
  assert.equal(verifyCsrfToken(req), true);
});

test('verifyCsrfToken rejects invalid token', () => {
  const req = {
    session: { csrfToken: 'abc123' },
    body: { _csrf: 'x' },
    get() { return ''; },
  };
  assert.equal(verifyCsrfToken(req), false);
});
