import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db.js';
import { logAuthEvent, purgeAuthAuditOlderThan } from '../lib/audit.js';

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

test('purgeAuthAuditOlderThan removes old rows', () => {
  db.prepare('DELETE FROM auth_audit').run();
  db.prepare(`
    INSERT INTO auth_audit (dt, event, email, ip, meta)
    VALUES (datetime('now','-200 days'), 'old_event', 'old@example.com', '1.1.1.1', NULL)
  `).run();
  db.prepare(`
    INSERT INTO auth_audit (dt, event, email, ip, meta)
    VALUES (datetime('now','-2 days'), 'new_event', 'new@example.com', '2.2.2.2', NULL)
  `).run();

  const removed = purgeAuthAuditOlderThan(90);
  assert.equal(removed, 1);

  const remains = db.prepare(`SELECT event FROM auth_audit ORDER BY id`).all().map(r => r.event);
  assert.deepEqual(remains, ['new_event']);
});
