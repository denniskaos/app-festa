import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(baseUrl, maxMs = 15000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < maxMs) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not become healthy within ${maxMs}ms`);
}

test('STRICT_CSRF bloqueia pedidos sem token e aceita o token da sessão', async () => {
  const port = String(5100 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const testDir = await mkdtemp(path.join(tmpdir(), 'festa-strict-csrf-'));
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(testDir, 'festa.db'),
      SESSIONS_DB: path.join(testDir, 'sessions.sqlite'),
      SESSION_SECRET: 'strict-csrf-integration-test',
      STRICT_CSRF: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(baseUrl);

    const page = await fetch(`${baseUrl}/registar`);
    assert.equal(page.status, 200);
    const cookie = (page.headers.get('set-cookie') || '').split(';', 1)[0];
    const html = await page.text();
    const csrfToken = html.match(/<meta name="csrf-token" content="([a-f0-9]+)"/i)?.[1];
    assert.ok(cookie.includes('connect.sid='));
    assert.ok(csrfToken);

    const body = new URLSearchParams({
      name: 'CSRF Test',
      email: `csrf-${Date.now()}@example.com`,
      password: 'FortePass2026$',
      confirm: 'FortePass2026$',
    }).toString();

    const blocked = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    assert.equal(blocked.status, 403);

    const accepted = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': csrfToken,
      },
      body,
      redirect: 'manual',
    });
    assert.equal(accepted.status, 302);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(testDir, { recursive: true, force: true });
  }
});
