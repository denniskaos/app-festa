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
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Server did not become healthy within ${maxMs}ms`);
}

test('password reset flow: request, admin approval and one-time reset', async () => {
  const port = String(4400 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const email = `reset-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
  const initialPassword = 'FortePass2026$';
  const nextPassword = 'NovaPass2026$';
  const testDir = await mkdtemp(path.join(tmpdir(), 'festa-reset-'));

  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(testDir, 'festa.db'),
      SESSIONS_DB: path.join(testDir, 'sessions.sqlite'),
      SESSION_SECRET: 'password-reset-integration-test',
    },
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
    const adminCookie = regRes.headers.get('set-cookie') || '';
    assert.ok(adminCookie.includes('connect.sid='));

    const forgotForm = new URLSearchParams({ email });
    const forgotRes = await fetch(`${baseUrl}/password/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: forgotForm.toString(),
    });
    assert.equal(forgotRes.status, 200);
    const forgotHtml = await forgotRes.text();
    assert.ok(forgotHtml.includes('pedido foi registado'));
    assert.equal(/\/password\/reset\?token=/i.test(forgotHtml), false, 'Reset link must not be exposed publicly');

    const requestsRes = await fetch(`${baseUrl}/seguranca/password-resets`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(requestsRes.status, 200);
    const requestsHtml = await requestsRes.text();
    const requestMatch = requestsHtml.match(/\/seguranca\/password-resets\/(\d+)\/generate/i);
    assert.ok(requestMatch, 'Expected a pending request in the admin page');

    const approveRes = await fetch(`${baseUrl}${requestMatch[0]}`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    assert.equal(approveRes.status, 200);
    const approveHtml = await approveRes.text();
    const tokenMatch = approveHtml.match(/\/password\/reset\?token=([a-f0-9]+)/i);
    assert.ok(tokenMatch, 'Expected a one-time reset link after admin approval');
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

    const reusedTokenRes = await fetch(`${baseUrl}/password/reset?token=${encodeURIComponent(token)}`);
    assert.equal(reusedTokenRes.status, 200);
    assert.ok((await reusedTokenRes.text()).includes('Link inválido ou expirado.'));
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
    await rm(testDir, { recursive: true, force: true });
  }
});
