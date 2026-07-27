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

    for (const pathName of ['/jantares/1/lancar', '/jantares/1/despesas/lancar']) {
      const legacyLaunch = await fetch(`${baseUrl}${pathName}`, {
        headers: { cookie },
        redirect: 'manual',
      });
      assert.equal(legacyLaunch.status, 405);
      assert.equal(legacyLaunch.headers.get('allow'), 'POST');
    }

    const leiloesBefore = await fetch(`${baseUrl}/leiloes`, { headers: { cookie } });
    assert.equal(leiloesBefore.status, 200);
    const leiloesBeforeHtml = await leiloesBefore.text();
    for (let numero = 1; numero <= 3; numero += 1) {
      assert.ok(leiloesBeforeHtml.includes(`Leilão ${numero}`));
    }
    assert.ok(leiloesBeforeHtml.includes('Leilão da Mota'));
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

    const updateLeilaoMota = await fetch(`${baseUrl}/leiloes/4`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ dt: '2026-07-25', valor_recebido: '250' }).toString(),
      redirect: 'manual',
    });
    assert.equal(updateLeilaoMota.status, 302);
    assert.ok(decodeURIComponent(updateLeilaoMota.headers.get('location') || '').includes(
      'Leilão da Mota atualizado.',
    ));

    const leiloesAfter = await fetch(`${baseUrl}/leiloes`, { headers: { cookie } });
    const leiloesAfterHtml = await leiloesAfter.text();
    assert.ok(leiloesAfterHtml.includes('2026-07-12'));
    assert.ok(leiloesAfterHtml.includes('2026-07-25'));
    assert.ok(leiloesAfterHtml.includes('123.45'));
    assert.ok(leiloesAfterHtml.includes('250.00'));
    assert.ok(leiloesAfterHtml.includes('373.45'));

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

    const applyRodizio = await fetch(`${baseUrl}/casais/rodizio/aplicar`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ casal_id: '1', valor: '160' }).toString(),
      redirect: 'manual',
    });
    assert.equal(applyRodizio.status, 302);
    const applyRodizioLocation = decodeURIComponent(
      (applyRodizio.headers.get('location') || '').replace(/\+/g, ' '),
    );
    assert.match(applyRodizioLocation, /Aplicação registada/);

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
    assert.ok(dashboardHtml.includes('€ 413.45'));
    assert.ok(dashboardHtml.includes('€ 500.00'));
    assert.equal(dashboardHtml.includes('€ 663.45'), false);
    assert.equal(dashboardHtml.includes('Caixa Total'), false);

    const createCavalosExpense = await fetch(`${baseUrl}/movimentos`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        dt: '2026-08-02',
        type: 'despesa',
        descr: 'Cavalos Procissão',
        valor: '321,45',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(createCavalosExpense.status, 302);

    const resumo = await fetch(`${baseUrl}/resumo-final?inicio=2026-01-01&fim=2026-12-31&destino=Pr%C3%B3xima+comiss%C3%A3o`, {
      headers: { cookie },
    });
    assert.equal(resumo.status, 200);
    const resumoHtml = await resumo.text();
    assert.ok(resumoHtml.includes('RESUMO FINAL DE CONTAS'));
    assert.ok(resumoHtml.includes('Peditórios'));
    assert.ok(resumoHtml.includes('Sábado Bombos'));
    assert.ok(resumoHtml.includes('Rifas/Malhas'));
    assert.ok(resumoHtml.includes('Leilões'));
    assert.ok(resumoHtml.includes('Venda de lugares'));
    assert.ok(resumoHtml.includes('Jantares/Almoços Artistas e Som'));
    assert.ok(resumoHtml.includes('Palco + Gerador + Vigilante'));
    assert.ok(resumoHtml.includes('Fogo de artifício'));
    assert.ok(resumoHtml.includes('Banda de Música'));
    assert.ok(resumoHtml.includes('Cavalos Procissão'));
    assert.ok(resumoHtml.includes('321,45'));
    assert.ok(resumoHtml.includes('Procissão'));
    assert.ok(resumoHtml.includes('373,45'));
    assert.ok(resumoHtml.includes('413,45'));
    assert.ok(resumoHtml.includes('Próxima comissão'));

    const peditorios = [
      {
        nome_pessoa: 'Ana',
        local: 'Vila Caiz',
        equipa: 'Grupo Azul',
        valor_prometido: '100',
        valor_entregue: '80',
      },
      {
        nome_pessoa: 'Bruno',
        local: 'Vila Caiz',
        equipa: 'grupo azul',
        valor_prometido: '50',
        valor_entregue: '50',
      },
      {
        nome_pessoa: 'Carla',
        local: 'Vila Caiz',
        equipa: 'Grupo Dourado',
        valor_prometido: '75',
        valor_entregue: '25',
      },
    ];

    for (const peditorio of peditorios) {
      const createPeditorio = await fetch(`${baseUrl}/peditorios`, {
        method: 'POST',
        headers: {
          cookie,
          origin: baseUrl,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(peditorio).toString(),
        redirect: 'manual',
      });
      assert.equal(createPeditorio.status, 302);
    }

    const peditoriosPage = await fetch(`${baseUrl}/peditorios`, { headers: { cookie } });
    assert.equal(peditoriosPage.status, 200);
    const peditoriosHtml = (await peditoriosPage.text()).replace(/\s+/g, ' ');
    assert.match(
      peditoriosHtml,
      /Grupo Azul<\/td> <td data-label="Prometido \(€\)">€ 150\.00<\/td> <td data-label="Entregue \(€\)">€ 130\.00<\/td> <td data-label="Em falta \(€\)">€ 20\.00<\/td>/,
    );
    assert.match(
      peditoriosHtml,
      /Grupo Dourado<\/td> <td data-label="Prometido \(€\)">€ 75\.00<\/td> <td data-label="Entregue \(€\)">€ 25\.00<\/td> <td data-label="Em falta \(€\)">€ 50\.00<\/td>/,
    );

    const vendasPorZona = [
      {
        nome: 'Comprador Cima',
        lugar: 'Bancada Cima 1',
        valor_total: '150',
        valor_pago: '150',
      },
      {
        nome: 'Comprador Baixo',
        lugar: 'Bancada Baixo 1',
        valor_total: '75',
        valor_pago: '25',
      },
    ];

    for (const venda of vendasPorZona) {
      const createVendaPorZona = await fetch(`${baseUrl}/lugares`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(venda).toString(),
        redirect: 'manual',
      });
      assert.equal(createVendaPorZona.status, 302);
    }

    const lugaresPorZonaPage = await fetch(`${baseUrl}/lugares`, { headers: { cookie } });
    assert.equal(lugaresPorZonaPage.status, 200);
    const lugaresPorZonaHtml = (await lugaresPorZonaPage.text()).replace(/\s+/g, ' ');
    assert.match(
      lugaresPorZonaHtml,
      /Total lugares de cima<\/div> <div class="stat-number">€ 150\.00<\/div>/,
    );
    assert.match(
      lugaresPorZonaHtml,
      /Pago — lugares de cima<\/div> <div class="stat-number">€ 150\.00<\/div>/,
    );
    assert.match(
      lugaresPorZonaHtml,
      /Em falta — lugares de cima<\/div> <div class="stat-number">€ 0\.00<\/div>/,
    );
    assert.match(
      lugaresPorZonaHtml,
      /Total lugares de baixo<\/div> <div class="stat-number">€ 75\.00<\/div>/,
    );
    assert.match(
      lugaresPorZonaHtml,
      /Pago — lugares de baixo<\/div> <div class="stat-number">€ 25\.00<\/div>/,
    );
    assert.match(
      lugaresPorZonaHtml,
      /Em falta — lugares de baixo<\/div> <div class="stat-number">€ 50\.00<\/div>/,
    );

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
