import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(baseUrl, maxMs = 15000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < maxMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not become healthy within ${maxMs}ms`);
}

test('integration: register then open /dashboard successfully', async () => {
  const port = String(4100 + Math.floor(Math.random() * 300));
  const baseUrl = `http://127.0.0.1:${port}`;
  const email = `int-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'FortePass2026$';

  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(baseUrl);

    const form = new URLSearchParams({
      name: 'Integration Test',
      email,
      password,
      confirm: password,
    });

    const regRes = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });

    assert.equal(regRes.status, 302);
    const cookie = regRes.headers.get('set-cookie') || '';
    assert.ok(cookie.includes('connect.sid='));

    const dashRes = await fetch(`${baseUrl}/dashboard`, {
      headers: { cookie },
    });
    assert.equal(dashRes.status, 200);
    const html = await dashRes.text();
    assert.ok(html.includes('Painel'));
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
});
