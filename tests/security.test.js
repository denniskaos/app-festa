import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOriginGuard, validatePasswordStrength } from '../lib/security.js';

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

test('sameOriginGuard rejects cross origin header', () => {
  const req = {
    get(name) {
      const k = String(name).toLowerCase();
      if (k === 'host') return 'example.org';
      if (k === 'origin') return 'https://evil.example.net';
      return '';
    },
  };
  assert.equal(sameOriginGuard(req, { strict: true }), false);
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
