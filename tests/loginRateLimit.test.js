import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db.js';
import {
  clearLoginRateLimit,
  clearLoginRateLimitByEmail,
  loginRateLimit,
} from '../middleware/loginRateLimit.js';

function mockReq(email = 'teste@example.com', ip = '127.0.0.1') {
  return {
    body: { email },
    ip,
    socket: { remoteAddress: ip },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    rendered: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, payload) {
      this.rendered = { view, payload };
      return this;
    },
  };
}

test('loginRateLimit allows first attempts and blocks after threshold', () => {
  db.prepare('DELETE FROM login_attempts').run();
  const req = mockReq();
  let nextCount = 0;

  for (let i = 0; i < 10; i += 1) {
    const res = mockRes();
    loginRateLimit(req, res, () => { nextCount += 1; });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(nextCount, 10);

  const blocked = mockRes();
  loginRateLimit(req, blocked, () => {});
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.rendered?.view, 'login');
});

test('clearLoginRateLimit removes throttle state', () => {
  db.prepare('DELETE FROM login_attempts').run();
  const req = mockReq('clear@example.com');

  for (let i = 0; i < 11; i += 1) {
    loginRateLimit(req, mockRes(), () => {});
  }
  clearLoginRateLimit(req);

  const afterClear = mockRes();
  let called = false;
  loginRateLimit(req, afterClear, () => { called = true; });
  assert.equal(called, true);
  assert.equal(afterClear.statusCode, 200);
});

test('clearLoginRateLimitByEmail removes rows regardless of ip', () => {
  db.prepare('DELETE FROM login_attempts').run();
  db.prepare(`INSERT INTO login_attempts (k, count, window_start_ms) VALUES ('1.1.1.1:mail@x.pt', 12, ?), ('2.2.2.2:mail@x.pt', 9, ?), ('3.3.3.3:other@x.pt', 5, ?)`)
    .run(Date.now(), Date.now(), Date.now());

  const removed = clearLoginRateLimitByEmail('mail@x.pt');
  assert.equal(removed, 2);

  const rows = db.prepare('SELECT k FROM login_attempts ORDER BY k').all().map(r => r.k);
  assert.deepEqual(rows, ['3.3.3.3:other@x.pt']);
});
