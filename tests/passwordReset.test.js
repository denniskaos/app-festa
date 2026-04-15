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

test('password reset flow: request token and reset password', async () => {
  const port = String(4400 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const email = `reset-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const initialPassword = 'FortePass2026$';
  const nextPassword = 'NovaPass2026$';

  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: port, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(baseUrl);

    const regForm = new URLSearchParams({
      name: 'Reset User',
      email,
      password: initialPassword,
      confirm: initialPassword,
    });
    const regRes = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: regForm.toString(),
      redirect: 'manual',
    });
    assert.equal(regRes.status, 302);

    const forgotForm = new URLSearchParams({ email });
    const forgotRes = await fetch(`${baseUrl}/password/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: forgotForm.toString(),
    });
    assert.equal(forgotRes.status, 200);
    const forgotHtml = await forgotRes.text();
    const tokenMatch = forgotHtml.match(/\/password\/reset\?token=([a-f0-9]+)/i);
    assert.ok(tokenMatch, 'Expected reset token link in non-production forgot page');
    const token = tokenMatch[1];

    const resetPage = await fetch(`${baseUrl}/password/reset?token=${encodeURIComponent(token)}`);
    assert.equal(resetPage.status, 200);

    const resetForm = new URLSearchParams({
      token,
      password: nextPassword,
      confirm: nextPassword,
    });
    const resetRes = await fetch(`${baseUrl}/password/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: resetForm.toString(),
      redirect: 'manual',
    });
    assert.equal(resetRes.status, 302);
    assert.ok((resetRes.headers.get('location') || '').startsWith('/login?msg='));

    const loginForm = new URLSearchParams({ email, password: nextPassword });
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: loginForm.toString(),
      redirect: 'manual',
    });
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('location'), '/dashboard');
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
});
