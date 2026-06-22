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

test('leilões e venda de lugares: registo, totais e validações', async () => {
  const port = String(4700 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const testDir = await mkdtemp(path.join(tmpdir(), 'festa-finance-'));
  const email = `finance-${Date.now()}@example.com`;
  const password = 'FortePass2026$';

  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(testDir, 'festa.db'),
      SESSIONS_DB: path.join(testDir, 'sessions.sqlite'),
      SESSION_SECRET: 'festa-finance-integration-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(baseUrl);

    const register = await fetch(`${baseUrl}/registar`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Finance Test', email, password, confirm: password,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(register.status, 302);
    const cookie = register.headers.get('set-cookie') || '';
    assert.ok(cookie.includes('connect.sid='));

    const leiloesBefore = await fetch(`${baseUrl}/leiloes`, { headers: { cookie } });
    assert.equal(leiloesBefore.status, 200);
    const leiloesBeforeHtml = await leiloesBefore.text();
    for (let numero = 1; numero <= 3; numero += 1) {
      assert.ok(leiloesBeforeHtml.includes(`Leilão ${numero}`));
    }
    assert.equal(leiloesBeforeHtml.includes('Leilão 4'), false);

    const updateLeilao = await fetch(`${baseUrl}/leiloes/1`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ dt: '2026-07-12', valor_recebido: '123,45' }).toString(),
      redirect: 'manual',
    });
    assert.equal(updateLeilao.status, 302);

    const leiloesAfter = await fetch(`${baseUrl}/leiloes`, { headers: { cookie } });
    const leiloesAfterHtml = await leiloesAfter.text();
    assert.ok(leiloesAfterHtml.includes('2026-07-12'));
    assert.ok(leiloesAfterHtml.includes('123.45'));

    const createVenda = await fetch(`${baseUrl}/lugares`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        nome: 'Maria Silva',
        lugar: 'Mesa 3 - Lugar 2',
        valor_total: '100',
        valor_pago: '40',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(createVenda.status, 302);

    const lugares = await fetch(`${baseUrl}/lugares`, { headers: { cookie } });
    assert.equal(lugares.status, 200);
    const lugaresHtml = await lugares.text();
    assert.ok(lugaresHtml.includes('Maria Silva'));
    assert.ok(lugaresHtml.includes('Mesa 3 - Lugar 2'));
    assert.ok(lugaresHtml.includes('€ 60.00'));

    const updateCasal = await fetch(`${baseUrl}/casais/1`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ nome: 'Casal 1', valor: '500' }).toString(),
      redirect: 'manual',
    });
    assert.equal(updateCasal.status, 302);

    const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.ok(dashboardHtml.includes('Leilões recebidos'));
    assert.ok(dashboardHtml.includes('Lugares recebidos'));
    assert.equal(dashboardHtml.includes('Lugares em falta'), false);
    assert.equal(dashboardHtml.includes('Lugares vendidos'), false);
    assert.ok(dashboardHtml.includes('€ 163.45'));
    assert.ok(dashboardHtml.includes('€ 500.00'));
    assert.equal(dashboardHtml.includes('€ 663.45'), false);
    assert.equal(dashboardHtml.includes('Caixa Total (Saldo + Em Casa)'), false);

    const duplicate = await fetch(`${baseUrl}/lugares`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        nome: 'Outro comprador',
        lugar: 'mesa 3 - lugar 2',
        valor_total: '80',
        valor_pago: '80',
      }).toString(),
    });
    assert.equal(duplicate.status, 409);

    const overpaid = await fetch(`${baseUrl}/lugares`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        nome: 'Comprador inválido',
        lugar: 'Lugar 99',
        valor_total: '50',
        valor_pago: '60',
      }).toString(),
    });
    assert.equal(overpaid.status, 400);
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
    await rm(testDir, { recursive: true, force: true });
  }
});
