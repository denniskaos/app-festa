import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function todayInLisbon() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

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

test('reconhece despesas existentes e usa a data da liquidação em novos movimentos', async () => {
  const port = String(5000 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const testDir = await mkdtemp(path.join(tmpdir(), 'festa-orcamento-'));
  const email = `orcamento-${Date.now()}@example.com`;
  const password = 'FortePass2026$';

  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(testDir, 'festa.db'),
      SESSIONS_DB: path.join(testDir, 'sessions.sqlite'),
      SESSION_SECRET: 'festa-orcamento-integration-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(baseUrl);

    const register = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Orçamento Test', email, password, confirm: password,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(register.status, 302);
    const cookie = register.headers.get('set-cookie') || '';

    const createExistingLine = await fetch(`${baseUrl}/orcamento`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        dt: '2026-08-15',
        descr: 'Bombos - parcela final',
        valor: '500',
        notas: 'Movimento já lançado manualmente',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(createExistingLine.status, 302);

    const createExistingMovement = await fetch(`${baseUrl}/movimentos`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        dt: '2026-07-30',
        type: 'despesa',
        descr: 'BOMBOS — PARCELA FINAL',
        valor: '500',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(createExistingMovement.status, 302);

    const createPendingLine = await fetch(`${baseUrl}/orcamento`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        dt: '2026-07-01',
        descr: 'Concertinas - segunda parcela',
        valor: '750,50',
        notas: 'Liquidar depois da festa',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(createPendingLine.status, 302);

    const budgetBefore = await fetch(`${baseUrl}/orcamento`, { headers: { cookie } });
    const budgetBeforeHtml = await budgetBefore.text();
    assert.equal(budgetBeforeHtml.includes('/orcamento/1/liquidar'), false);
    assert.ok(budgetBeforeHtml.includes('/orcamento/2/liquidar'));
    assert.ok(budgetBeforeHtml.includes('Liquidado'));
    assert.ok(budgetBeforeHtml.includes('Liquidar'));

    const settle = await fetch(`${baseUrl}/orcamento/2/liquidar`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(settle.status, 303);
    assert.ok(decodeURIComponent(settle.headers.get('location') || '').includes(
      'Parcela liquidada e movimento de despesa criado.',
    ));

    const budgetAfter = await fetch(`${baseUrl}/orcamento`, { headers: { cookie } });
    const budgetAfterHtml = await budgetAfter.text();
    assert.ok(budgetAfterHtml.includes('Liquidado'));
    assert.equal(budgetAfterHtml.includes('/orcamento/2/liquidar'), false);

    const movements = await fetch(`${baseUrl}/movimentos`, { headers: { cookie } });
    const movementsHtml = await movements.text();
    assert.ok(movementsHtml.includes(todayInLisbon()));
    assert.equal(movementsHtml.includes('2026-07-01'), false);
    assert.ok(movementsHtml.includes('2026-07-30'));
    assert.ok(movementsHtml.includes('despesa'));
    assert.ok(movementsHtml.includes('Concertinas - segunda parcela'));
    assert.ok(movementsHtml.includes('750.50'));

    const settleAgain = await fetch(`${baseUrl}/orcamento/2/liquidar`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(settleAgain.status, 303);
    assert.ok(decodeURIComponent(settleAgain.headers.get('location') || '').includes(
      'Esta parcela já está liquidada.',
    ));

    const movementsAfterRetry = await fetch(`${baseUrl}/movimentos`, { headers: { cookie } });
    const movementsAfterRetryHtml = await movementsAfterRetry.text();
    assert.equal(
      movementsAfterRetryHtml.split('Concertinas - segunda parcela').length - 1,
      1,
    );

    const movementId = movementsAfterRetryHtml.match(/\/movimentos\/(\d+)\/edit/)?.[1];
    assert.ok(movementId);
    const deleteMovement = await fetch(`${baseUrl}/movimentos/${movementId}/delete`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(deleteMovement.status, 302);

    const budgetReopened = await fetch(`${baseUrl}/orcamento`, { headers: { cookie } });
    const budgetReopenedHtml = await budgetReopened.text();
    assert.ok(budgetReopenedHtml.includes('/orcamento/2/liquidar'));
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
    await rm(testDir, { recursive: true, force: true });
  }
});
