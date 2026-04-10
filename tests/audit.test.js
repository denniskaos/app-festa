import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db.js';
import { logAuthEvent } from '../lib/audit.js';

test('logAuthEvent writes entry into auth_audit table', () => {
  db.prepare('DELETE FROM auth_audit').run();
  logAuthEvent({
    event: 'unit_test_event',
    email: 'audit@example.com',
    ip: '127.0.0.1',
    meta: { source: 'test' },
  });

  const row = db.prepare(`
    SELECT event, email, ip, meta
    FROM auth_audit
    ORDER BY id DESC
    LIMIT 1
  `).get();

  assert.equal(row.event, 'unit_test_event');
  assert.equal(row.email, 'audit@example.com');
  assert.equal(row.ip, '127.0.0.1');
  assert.ok(String(row.meta || '').includes('"source":"test"'));
});

