import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCors, originFromEnv, parseOrigins, CorsConfigError } from '../api/cors.ts';
import { buildApp } from '../api/server.ts';
import type { SessionView } from '../api/sessions.ts';
import { EVENT_TYPES, JOURNAL_WINDOW, replayWithinWindow, trimToWindow, isKnownEventType } from '../api/stream.ts';
import { API_VERSION, SUPPORTED_VERSIONS, pathV1, versioned } from '../api/version.ts';
import { hasEnum } from '../contract/boundary.ts';
import type { FastifyInstance } from 'fastify';

async function withApp(fn: (app: FastifyInstance) => Promise<void>, cors = { origins: [] as string[] }): Promise<void> {
  const app = await buildApp(undefined, cors);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function create(app: FastifyInstance): Promise<SessionView> {
  const response = await app.inject({
    method: 'POST',
    url: pathV1('/sessions'),
    payload: { seed: 42, level: 'clean', overlay: 'none' },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as SessionView;
}

test('версия идёт префиксом пути и дублируется в теле', async () => {
  assert.equal(VERSION_PREFIX_OK(), true);
  await withApp(async (app) => {
    const created = await create(app);
    assert.equal(created.apiVersion, API_VERSION);
    const view = await app.inject({ method: 'GET', url: pathV1(`/sessions/${created.id}`) });
    assert.equal(view.statusCode, 200);
    assert.equal((view.json() as SessionView).apiVersion, API_VERSION);
  });
});

function VERSION_PREFIX_OK(): boolean {
  return pathV1('/sessions') === '/v1/sessions' && SUPPORTED_VERSIONS.includes('v1' as never);
}

test('неизвестная версия — 404 с перечислением поддерживаемых, а не 400', async () => {
  await withApp(async (app) => {
    for (const url of ['/v2/sessions', '/v2/sessions/abc', '/v0/sessions']) {
      const response = await app.inject({ method: 'POST', url, payload: { seed: 1, level: 'clean', overlay: 'none' } });
      assert.equal(response.statusCode, 404, `${url} должен дать 404, получено ${response.statusCode}`);
      const body = response.json() as { error: string; supported: string[]; apiVersion: string };
      assert.equal(body.error, 'unknown-api-version');
      assert.deepEqual(body.supported, ['v1']);
      assert.equal(body.apiVersion, API_VERSION);
    }
  });
});

test('отказ несёт версию в теле', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    // Решение в прошлое возможно только когда смена уже сдвинута: на нулевой
    // смене appliedAt=0 — это текущая смена, а не прошлое.
    await app.inject({ method: 'POST', url: pathV1(`/sessions/${created.id}/advance`) });
    const past = await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${created.id}/decisions`),
      payload: { type: 'priority', batchId: 'batch-3', rank: 0, appliedAt: 0 },
    });
    assert.equal(past.statusCode, 409, past.body);
    assert.equal((past.json() as { apiVersion: string }).apiVersion, API_VERSION);
    const missing = await app.inject({ method: 'GET', url: pathV1('/sessions/nope') });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { apiVersion: string }).apiVersion, API_VERSION);
  });
});

test('маршрут без версии не отвечает как v1', async () => {
  await withApp(async (app) => {
    const withoutVersion = await app.inject({ method: 'POST', url: '/sessions', payload: { seed: 1, level: 'clean', overlay: 'none' } });
    assert.equal(withoutVersion.statusCode, 404, 'путь без версии не должен обслуживаться');
    const body = withoutVersion.json() as { apiVersion: string };
    assert.equal(body.apiVersion, API_VERSION);
  });
});

test('CORS: источник из списка получает заголовок, чужой — нет', async () => {
  const cors = { origins: ['http://127.0.0.1:5173'] };
  await withApp(async (app) => {
    const allowed = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      headers: { origin: 'http://127.0.0.1:5173' },
      payload: { seed: 2, level: 'clean', overlay: 'none' },
    });
    assert.equal(allowed.statusCode, 201);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');

    const alien = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      headers: { origin: 'http://evil.example' },
      payload: { seed: 2, level: 'clean', overlay: 'none' },
    });
    assert.equal(alien.headers['access-control-allow-origin'], undefined);
  }, cors);
});

test('CORS: запрос без Origin проходит (curl, тесты, сервер-сервер)', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: pathV1('/sessions'), payload: { seed: 3, level: 'clean', overlay: 'none' } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }, { origins: ['http://127.0.0.1:5173'] });
});

test('CORS: звёздочка отвергается при разборе конфигурации', () => {
  assert.throws(() => parseOrigins('*'), CorsConfigError);
  assert.throws(() => parseOrigins('http://a.example,*'), CorsConfigError);
  assert.throws(() => parseOrigins('не-адрес'), CorsConfigError);
  assert.deepEqual(parseOrigins('http://127.0.0.1:5173, http://localhost:5173').origins, [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  assert.deepEqual(parseOrigins(undefined).origins, []);
  assert.deepEqual(parseOrigins('   ').origins, []);
  assert.deepEqual(originFromEnv({ SIM_API_CORS_ORIGINS: 'http://127.0.0.1:5173' }).origins, ['http://127.0.0.1:5173']);
});

test('CORS: чужой источник не доверен решением', () => {
  const config = { origins: ['http://127.0.0.1:5173'] };
  assert.deepEqual(decideCors(config, 'http://127.0.0.1:5173'), { allowed: true, allowOrigin: 'http://127.0.0.1:5173' });
  assert.deepEqual(decideCors(config, 'http://evil.example'), { allowed: false, allowOrigin: null });
  assert.deepEqual(decideCors(config, undefined), { allowed: true, allowOrigin: null });
});

test('реестр событий закрыт пятью типами', () => {
  assert.deepEqual([...EVENT_TYPES], [
    'shift-started',
    'shift-completed',
    'metrics-updated',
    'decision-applied',
    'session-finished',
  ]);
  assert.equal(isKnownEventType('shift-completed'), true);
  assert.equal(isKnownEventType('teleport'), false);
});

test('журнал держит окно и отвечает oldestSeq вне окна', () => {
  const events = Array.from({ length: JOURNAL_WINDOW + 50 }, (_, index) => ({ seq: index + 1, type: 'shift-started' }));
  const trimmed = trimToWindow([...events]);
  assert.equal(trimmed.length, JOURNAL_WINDOW);
  assert.equal(trimmed[0]?.seq, 51);
  assert.equal(trimmed.at(-1)?.seq, JOURNAL_WINDOW + 50);

  const inside = replayWithinWindow(trimmed, 60);
  assert.equal(inside.exceeded, null);
  assert.equal(inside.events.every((event) => event.seq > 60), true);

  const outside = replayWithinWindow(trimmed, 10);
  assert.notEqual(outside.exceeded, null);
  assert.equal(outside.exceeded?.error, 'journal-window-exceeded');
  assert.equal(outside.exceeded?.oldestSeq, 51);
});

test('восстановление из начала журнала не считается выходом за окно', () => {
  const events = [{ seq: 1, type: 'shift-started' }, { seq: 2, type: 'shift-completed' }];
  const replay = replayWithinWindow(events, 0);
  assert.equal(replay.exceeded, null);
  assert.equal(replay.events.length, 2);
});

test('enum запрещён в серверной зоне', () => {
  assert.equal(hasEnum('enum Color { Red }'), true);
  assert.equal(hasEnum('export enum Color { Red }'), true);
  assert.equal(hasEnum('const enum Color { Red }'), true);
  assert.equal(hasEnum('  enum Nested { A }'), true);
  assert.equal(hasEnum("export const ROLES = ['a', 'b'] as const;"), false);
  assert.equal(hasEnum('export type Role = (typeof ROLES)[number];'), false);
  assert.equal(hasEnum('// enum mention in comment text only\nconst x = 1;'), false);
});

test('versioned не даёт версии потеряться в ответе-объекте', () => {
  const body = versioned({ layer: 'summary' as const });
  assert.equal(body.apiVersion, API_VERSION);
  assert.equal(body.layer, 'summary');
});
