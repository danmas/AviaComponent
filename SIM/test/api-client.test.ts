import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../api/server.ts';
import { createClient, isKnownEvent, KNOWN_EVENTS, ApiClientError, type StreamEvent, type Transport } from '../api-client/client.ts';
import { importViolation, scanBoundary } from '../contract/boundary.ts';
import type { FastifyInstance } from 'fastify';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Транспорт поверх app.inject: клиент не знает, что за ним Fastify. */
function injectTransport(app: FastifyInstance): Transport {
  return async (input, init) => {
    const url = input.replace(/^https?:\/\/[^/]+/, '');
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url,
      ...(init?.body === undefined ? {} : { payload: init.body, headers: init.headers ?? {} }),
    });
    return {
      status: response.statusCode,
      headers: { get: (name: string) => response.headers[name.toLowerCase()] as string | null ?? null },
      json: async () => JSON.parse(response.body) as unknown,
      text: async () => response.body,
    };
  };
}

async function withClient(fn: (client: ReturnType<typeof createClient>) => Promise<void>): Promise<void> {
  const app = await buildApp();
  try {
    await fn(createClient({ baseUrl: 'http://127.0.0.1:3400', transport: injectTransport(app) }));
  } finally {
    await app.close();
  }
}

test('клиент получает срез свода и видит слой summary', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    assert.equal(created.apiVersion, 'v1');
    const view = await client.session(created.id);
    assert.equal(view.summary.layer, 'summary');
    assert.equal(view.currentShift, 0);
    // Свод не несёт цеха: у него четыре показателя, а не состояние станков.
    assert.deepEqual(Object.keys(view.summary.metrics).sort(), ['acceptedShift', 'overload', 'portfolio', 'scheduleRisk']);
    assert.equal('reality' in view.summary, false, 'свод не должен нести срез цеха');
  });
});

test('клиент отдаёт срез цеха отдельным вызовом', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    const shop = await client.shop(created.id);
    assert.equal(shop.layer, 'shop');
    assert.equal(shop.shift, 0);
    assert.ok(shop.reality !== undefined, 'срез цеха обязан нести reality');
  });
});

test('клиент отдаёт записи ролей', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    const roles = await client.roles(created.id);
    assert.equal(roles.layer, 'roles');
    assert.ok(Array.isArray(roles.records));
  });
});

test('клиент продвигает смену и получает события', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    const advanced = await client.advance(created.id);
    assert.equal(advanced.currentShift, 1);
    assert.ok(advanced.events.length > 0);
    for (const event of advanced.events) {
      assert.equal(isKnownEvent(event as StreamEvent), true, `тип ${event.type} вне реестра`);
    }
  });
});

test('advance не шлёт content-type без тела', async () => {
  // Регрессия: клиент ставил application/json на POST без тела, и Fastify
  // отвечал 400 «Body cannot be empty». Смену нельзя было продвинуть вообще.
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    for (let step = 1; step <= 3; step += 1) {
      const advanced = await client.advance(created.id);
      assert.equal(advanced.currentShift, step, `шаг ${step} не прошёл`);
    }
    const shop = await client.shop(created.id, 3);
    assert.equal(shop.shift, 3);
    assert.equal(shop.reality.now, 2880, 'смена 3 — минута 2880');
  });
});

test('прошлый срез цеха доступен после шага', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    for (let step = 0; step < 3; step += 1) {
      await client.advance(created.id);
    }
    const now = await client.shop(created.id, 3);
    const before = await client.shop(created.id, 2);
    assert.equal(now.shift, 3);
    assert.equal(before.shift, 2);
    // Прошлый срез не переписан текущим: у них разные минуты.
    assert.notEqual(now.reality.now, before.reality.now);
  });
});

test('клиент строит адрес потока с версией и номером', async () => {
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    assert.equal(client.streamUrl(created.id), `ws://127.0.0.1:3400/v1/sessions/${created.id}/stream`);
    assert.equal(client.streamUrl(created.id, 7), `ws://127.0.0.1:3400/v1/sessions/${created.id}/stream?lastSeq=7`);
  });
});

test('клиент превращает отказ в ApiClientError с кодом', async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.session('нет-такой-сессии'),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 404);
        return true;
      },
    );
    const created = await client.createSession({ seed: 42, level: 'clean', overlay: 'none' });
    await client.advance(created.id);
    await assert.rejects(
      () => client.decide(created.id, { type: 'priority', batchId: 'batch-3', rank: 0, appliedAt: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 409);
        return true;
      },
    );
  });
});

test('клиент отвергает ответ чужой версии, а не глотает молча', async () => {
  const alien: Transport = async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ apiVersion: 'v2', layer: 'summary' }),
    text: async () => JSON.stringify({ apiVersion: 'v2', layer: 'summary' }),
  });
  const client = createClient({ baseUrl: 'http://127.0.0.1:3400', transport: alien, apiVersion: 'v1' });
  await assert.rejects(() => client.session('x'), /Ответ версии «v2», клиент ждёт «v1»/);
});

test('клиент работает в Node без браузерных глобальных объектов', async () => {
  // fetch в Node 24 есть, но клиент обязан брать его из среды, а не из window.
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  await withClient(async (client) => {
    const created = await client.createSession({ seed: 7, level: 'late', overlay: 'none' });
    const view = await client.session(created.id);
    assert.equal(view.summary.layer, 'summary');
    assert.equal(view.level, 'late');
  });
});

test('реестр событий клиента совпадает с реестром сервера', async () => {
  const { EVENT_TYPES } = await import('../api/stream.ts');
  assert.deepEqual([...KNOWN_EVENTS], [...EVENT_TYPES]);
});

test('клиент не тянет серверные модули и транспортные библиотеки', () => {
  for (const name of ['client.ts', 'types.ts', 'index.ts']) {
    const file = path.join(root, 'api-client', name);
    assert.equal(fs.existsSync(file), true, `${name} нет в api-client`);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of source.matchAll(/from\s+'([^']+)'/g)) {
      const target = specifier[1];
      if (target === undefined || target.startsWith('node:')) {
        continue;
      }
      assert.equal(target.startsWith('../api/'), false, `${name} импортирует серверный модуль ${target}`);
      assert.equal(/^(fastify|@fastify)/.test(target), false, `${name} импортирует ${target}`);
      assert.equal(target === 'react', false, `${name} импортирует react`);
    }
  }
});

test('граница закрывает клиенту серверный рантайм и пускает к своим типам', () => {
  const clientFile = path.join(root, 'api-client', 'client.ts');
  // Клиент ходит к серверу по сети: импорт серверных модулей запрещён.
  assert.notEqual(importViolation(clientFile, '../api/server.ts'), null, 'клиенту нельзя импортировать сервер');
  assert.notEqual(importViolation(clientFile, '../plant/state.ts'), null, 'клиенту нельзя импортировать цех');
  assert.notEqual(importViolation(clientFile, 'fastify'), null, 'клиенту нельзя импортировать транспорт');
  // Свои сгенерированные типы — можно.
  assert.equal(importViolation(clientFile, './types.ts'), null, 'свои типы клиенту доступны');
  // Ядру клиент тоже закрыт: контракт не импортирует клиента.
  const contractFile = path.join(root, 'contract', 'slices.ts');
  assert.notEqual(importViolation(contractFile, '../api-client/types.ts'), null, 'контракту клиент не доступен');
  assert.deepEqual(scanBoundary().filter((line) => line.includes('api-client')), []);
});
