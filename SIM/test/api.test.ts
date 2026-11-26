import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp, DEFAULT_PORT, portFromEnv, PortBusyError, startApi } from '../api/server.ts';
import type { SessionEvent, SessionView, ShopBody, SummaryBody } from '../api/sessions.ts';
import { importViolation, scanBoundary } from '../contract/boundary.ts';
import { CONTRACT_STAND } from '../contract/stand.ts';
import { SHIFT_MINUTES, shiftWindow } from '../contract/time.ts';
import { EXPECTED } from '../run/levels.ts';
import { runStand } from '../run/run.ts';
import { fourMetrics } from '../system/metrics.ts';
import type { FastifyInstance } from 'fastify';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED = new Set(['operations', 'downtimes', 'batches', 'resources']);

function bannedKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      bannedKeys(item, found);
    }
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (BANNED.has(key)) {
        found.push(key);
      }
      bannedKeys(child, found);
    }
  }
  return found;
}

async function withApp(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function create(app: FastifyInstance, extra: { horizonShifts?: number; seed?: number } = {}): Promise<SessionView> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    payload: {
      seed: extra.seed ?? 42,
      level: 'clean',
      overlay: 'none',
      ...(extra.horizonShifts === undefined ? {} : { horizonShifts: extra.horizonShifts }),
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as SessionView;
}

async function advance(app: FastifyInstance, id: string): Promise<{ currentShift: number; summary: SummaryBody; events: SessionEvent[] }> {
  const response = await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { currentShift: number; summary: SummaryBody; events: SessionEvent[] };
}

function levelArgs(): { orders: number; areas: number; shiftFacts: number } {
  return { orders: EXPECTED.orders, areas: EXPECTED.loadAreas, shiftFacts: EXPECTED.marks };
}

async function openStream(app: FastifyInstance, id: string, lastSeq = 0): Promise<{ events: SessionEvent[]; close: () => void; send: (text: string) => void }> {
  const events: SessionEvent[] = [];
  const ws = await app.injectWS(`/v1/sessions/${id}/stream?lastSeq=${lastSeq}`, {}, {
    onInit(socket) {
      socket.on('message', (data: unknown) => {
        events.push(JSON.parse(String(data)) as SessionEvent);
      });
    },
  });
  return {
    events,
    close: () => {
      ws.terminate();
    },
    send: (text: string) => {
      ws.send(text);
    },
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) {
      throw new Error('таймаут события');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function holdPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('нет порта'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });
}

function freePort(): Promise<number> {
  return holdPort().then(async (held) => {
    const { port } = held;
    await held.close();
    return port;
  });
}

function spawnApi(envPort: string): ChildProcess {
  return spawn(process.execPath, ['--experimental-strip-types', 'api/main.ts'], {
    cwd: root,
    env: { ...process.env, SIM_API_PORT: envPort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('порт по умолчанию 3400, переменная его заменяет', () => {
  assert.equal(DEFAULT_PORT, 3400);
  assert.equal(portFromEnv({}), 3400);
  assert.equal(portFromEnv({ SIM_API_PORT: '3407' }), 3407);
  assert.throws(() => portFromEnv({ SIM_API_PORT: 'abc' }), /SIM_API_PORT/);
});

test('занятый порт останавливает сервер', async () => {
  const held = await holdPort();
  try {
    await assert.rejects(startApi({ port: held.port }), (error: unknown) => {
      assert.ok(error instanceof PortBusyError);
      assert.match(error.message, /занят/);
      assert.ok(error.message.includes(String(held.port)));
      return true;
    });
    const child = spawnApi(String(held.port));
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /занят/);
    assert.equal(outcome.stdout.includes('Сервер слушает'), false);
  } finally {
    await held.close();
  }
});

test('процесс слушает заданный порт', async () => {
  const port = await freePort();
  const child = spawnApi(String(port));
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const started = Date.now();
    while (!stdout.includes('Сервер слушает')) {
      if (child.exitCode !== null || Date.now() - started > 8000) {
        throw new Error(`сервер не поднялся, код ${child.exitCode}\n${stdout}\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(stdout, new RegExp(`Сервер слушает 127\\.0\\.0\\.1:${port}`));
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 1, level: 'clean', overlay: 'none', horizonShifts: 10 }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as SessionView;
    assert.equal(body.horizonShifts, 10);
    assert.equal(body.replayable, true);
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(undefined);
        return;
      }
      child.on('exit', () => resolve(undefined));
    });
  }
});

test('в метаданных нет состояния цеха, свод — первая смена', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    assert.equal(created.replayable, true);
    assert.equal(created.currentShift, 0);
    assert.equal(created.horizonShifts, CONTRACT_STAND.horizonShifts);
    assert.equal(created.summary.layer, 'summary');
    assert.deepEqual(bannedKeys(created), []);
    const direct = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 1, priority: [] });
    const metrics = fourMetrics(direct.records, levelArgs(), shiftWindow(0, 1));
    assert.deepEqual(created.summary.metrics, metrics);
    const full = runStand({ seed: 42, level: 'clean', overlay: 'none', priority: [] });
    const end = fourMetrics(full.records, levelArgs(), shiftWindow(CONTRACT_STAND.horizonShifts - 1, CONTRACT_STAND.horizonShifts));
    assert.notDeepEqual(created.summary.metrics, end);
  });
});

test('горизонт вне 10–15 назван в отказе', async () => {
  await withApp(async (app) => {
    for (const horizonShifts of [9, 16, 0]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        payload: { seed: 42, level: 'clean', overlay: 'none', horizonShifts },
      });
      assert.equal(response.statusCode, 400, response.body);
      const body = response.json() as { error?: string; horizonShifts?: number };
      assert.match(body.error ?? '', new RegExp(String(CONTRACT_STAND.horizonShiftsMin)));
      assert.match(body.error ?? '', new RegExp(String(CONTRACT_STAND.horizonShiftsMax)));
      assert.equal(body.horizonShifts, undefined);
    }
    const low = await create(app, { horizonShifts: CONTRACT_STAND.horizonShiftsMin });
    const high = await create(app, { horizonShifts: CONTRACT_STAND.horizonShiftsMax, seed: 7 });
    assert.equal(low.horizonShifts, 10);
    assert.equal(high.horizonShifts, 15);
  });
});

test('срез цеха отдельным маршрутом, роли без станков', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    const shop = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/shop` });
    assert.equal(shop.statusCode, 200);
    const shopBody = shop.json() as ShopBody;
    assert.equal(shopBody.layer, 'shop');
    assert.ok(Array.isArray(shopBody.reality.operations));
    assert.ok(Array.isArray(shopBody.reality.downtimes));
    const roles = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/roles` });
    const rolesBody = roles.json() as { layer: string };
    assert.equal(rolesBody.layer, 'roles');
    assert.deepEqual(bannedKeys(rolesBody), []);
    const meta = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    const metaBody = meta.json() as { layer?: string };
    assert.equal(metaBody.layer, undefined);
    assert.deepEqual(bannedKeys(metaBody), []);
  });
});

test('мощность берётся из записей прогона, единицы не смешиваются', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    assert.equal(created.summary.areas.length, EXPECTED.loadAreas);
    const kinds = new Set(created.summary.areas.map((area) => area.capacity.kind));
    assert.ok(kinds.has('machine-hour'));
    assert.ok(kinds.has('charge-day'));
    assert.ok(kinds.size > 1);
    const shift0 = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 1, priority: [] });
    assert.deepEqual(
      created.summary.areas.map((area) => [area.areaId, area.capacity.kind, area.capacity.amount]),
      shift0.records.areaLoads.map((area) => [area.areaId, area.capacity.kind, area.capacity.amount]),
    );
    const id = created.id;
    for (let step = 0; step < 5; step += 1) {
      await advance(app, id);
    }
    const at5 = await app.inject({ method: 'GET', url: `/v1/sessions/${id}?shift=5` });
    const summary = (at5.json() as SessionView).summary;
    const cut = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 6, priority: [] });
    const full = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 12, priority: [] });
    assert.deepEqual(
      summary.areas.map((area) => [area.areaId, area.capacity, area.plan, area.queue]),
      cut.records.areaLoads.map((area) => [area.areaId, area.capacity, area.plan, area.queue]),
    );
    assert.notDeepEqual(
      summary.areas.map((area) => [area.plan.amount, area.queue.amount]),
      full.records.areaLoads.map((area) => [area.plan.amount, area.queue.amount]),
    );
  });
});

test('решение на смене 4 пишется на её начало и не меняет выданный срез', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    for (let step = 0; step < 4; step += 1) {
      await advance(app, created.id);
    }
    const before = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    const beforeBody = before.json() as SessionView;
    assert.equal(beforeBody.currentShift, 4);
    const shopBefore = (await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/shop` })).json();
    const rolesBefore = (await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/roles` })).json();

    const past = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.id}/decisions`,
      payload: { type: 'priority', batchId: 'batch-3', rank: 0, appliedAt: 0 },
    });
    assert.equal(past.statusCode, 409, past.body);
    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.id}/decisions`,
      payload: { type: 'speed', batchId: 'batch-3', rank: 0 },
    });
    assert.equal(unknown.statusCode, 400, unknown.body);
    assert.match((unknown.json() as { error: string }).error, /priority/);
    const unchanged = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    assert.equal(unchanged.body, before.body);

    const decision = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.id}/decisions`,
      payload: { type: 'priority', batchId: 'batch-3', rank: 0 },
    });
    assert.equal(decision.statusCode, 200, decision.body);
    const decided = decision.json() as {
      decision: { appliedAt: number };
      journal: { at: number; action: string; basisMetric: string; basisValue: string; coverage: number };
      event: SessionEvent;
    };
    assert.equal(decided.decision.appliedAt, 4 * SHIFT_MINUTES);
    assert.equal(decided.journal.at, 4 * SHIFT_MINUTES);
    assert.equal(decided.event.at, 4 * SHIFT_MINUTES);
    assert.equal(decided.event.type, 'decision-applied');
    assert.equal(decided.journal.basisMetric, 'scheduleRisk');
    assert.ok(decided.journal.action.length > 0);
    assert.ok(decided.journal.coverage >= 0 && decided.journal.coverage <= 1);
    assert.deepEqual(JSON.parse(decided.journal.basisValue), beforeBody.summary.metrics.scheduleRisk.value);
    const still = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    assert.deepEqual((still.json() as SessionView).summary, beforeBody.summary);

    await advance(app, created.id);
    const again = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}?shift=4` });
    assert.deepEqual((again.json() as SessionView).summary, beforeBody.summary);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/shop?shift=4` })).json(), shopBefore);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}/roles?shift=4` })).json(), rolesBefore);

    const replay = await create(app, { seed: 42 });
    for (let step = 0; step < 4; step += 1) {
      await advance(app, replay.id);
    }
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${replay.id}/decisions`,
      payload: { type: 'priority', batchId: 'batch-3', rank: 0 },
    });
    const replayed = await advance(app, replay.id);
    const original = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    assert.deepEqual(replayed.summary, (original.json() as SessionView).summary);
  });
});

test('срез на смене 11 отличается от нулевой, номера событий растут', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    const first = created.summary;
    let previousMax = 0;
    let lastEvents: SessionEvent[] = [];
    for (let shift = 1; shift <= 11; shift += 1) {
      const step = await advance(app, created.id);
      assert.equal(step.currentShift, shift);
      const seqs = step.events.map((event) => event.seq);
      assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
      assert.ok(Math.min(...seqs) > previousMax);
      previousMax = Math.max(...seqs);
      lastEvents = step.events;
      assert.ok(step.events.some((event) => event.type === 'shift-started'));
      assert.ok(step.events.some((event) => event.type === 'shift-completed'));
      assert.ok(step.events.some((event) => event.type === 'metrics-updated'));
    }
    const end = await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` });
    const endBody = end.json() as SessionView;
    assert.equal(endBody.currentShift, 11);
    assert.notDeepEqual(endBody.summary.metrics, first.metrics);
    assert.ok(lastEvents.some((event) => event.type === 'session-finished'));
    const refused = await app.inject({ method: 'POST', url: `/v1/sessions/${created.id}/advance` });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/sessions/${created.id}` })).json().currentShift, 11);
  });
});

test('WebSocket шагает и не повторяет уже полученные события', async () => {
  await withApp(async (app) => {
    const created = await create(app);
    const live = await openStream(app, created.id, 0);
    try {
      const httpStep = await advance(app, created.id);
      await waitUntil(() => live.events.length >= httpStep.events.length);
      assert.deepEqual(live.events.slice(0, httpStep.events.length), httpStep.events);
      const last = httpStep.events.at(-1)?.seq ?? 0;
      live.send(JSON.stringify({ type: 'advance' }));
      await waitUntil(() => live.events.length >= httpStep.events.length + 3);
      const second = live.events.slice(httpStep.events.length);
      assert.ok(Math.min(...second.map((event) => event.seq)) > last);
      live.close();

      const again = await openStream(app, created.id, second.at(-1)?.seq ?? last);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(again.events.length, 0);
      const third = await advance(app, created.id);
      await waitUntil(() => again.events.length >= third.events.length);
      const seen = new Set(live.events.map((event) => event.seq));
      for (const event of again.events) {
        assert.ok(event.seq > (second.at(-1)?.seq ?? last));
        assert.equal(seen.has(event.seq), false);
      }
      assert.deepEqual(again.events.slice(0, third.events.length), third.events);
      again.close();
    } finally {
      live.close();
    }
  });
});

test('обработчик не считает мощность и очередь', () => {
  for (const name of ['sessions.ts', 'server.ts', 'main.ts']) {
    const source = fs.readFileSync(path.join(root, 'api', name), 'utf8');
    for (const word of ['machine-hour', 'person-hour', 'charge-day', 'occupationMinutes', 'capacityOf', 'compareReady']) {
      assert.equal(source.includes(word), false, `${name} содержит ${word}`);
    }
  }
  assert.match(fs.readFileSync(path.join(root, 'api', 'sessions.ts'), 'utf8'), /runStand\(/);
  const readme = fs.readFileSync(path.join(root, 'README_API.md'), 'utf8');
  assert.match(readme, /v1 умеет одно решение/);
  assert.match(readme, /\/sessions\/:id\/advance/);
  assert.match(readme, /priority/);
});

test('ядро не импортирует сервер, серверу ядро доступно', () => {
  assert.deepEqual(scanBoundary(root), []);
  assert.ok(importViolation(path.join(root, 'plant', 'engine.ts'), '../api/server.ts'));
  assert.ok(importViolation(path.join(root, 'system', 'metrics.ts'), '../api/server.ts'));
  assert.ok(importViolation(path.join(root, 'contract', 'events.ts'), '../api/server.ts'));
  assert.equal(importViolation(path.join(root, 'api', 'sessions.ts'), '../plant/engine.ts'), null);
  assert.equal(importViolation(path.join(root, 'api', 'sessions.ts'), '../system/metrics.ts'), null);
  assert.equal(importViolation(path.join(root, 'api', 'server.ts'), 'fastify'), null);
  assert.ok(importViolation(path.join(root, 'plant', 'engine.ts'), 'fastify'));
  assert.equal(importViolation(path.join(root, 'test', 'api.test.ts'), '../api/server.ts'), null);

  const direct = spawnSync(process.execPath, ['--experimental-strip-types', 'contract/boundary.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(direct.status, 0, direct.stderr);

  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'avia-boundary-'));
  try {
    fs.mkdirSync(path.join(fake, 'plant'));
    fs.mkdirSync(path.join(fake, 'api'));
    fs.mkdirSync(path.join(fake, 'contract'));
    fs.writeFileSync(path.join(fake, 'plant', 'leak.ts'), "import { shop } from '../api/server.ts';\n");
    fs.writeFileSync(path.join(fake, 'api', 'use-core.ts'), "import { shop } from '../plant/engine.ts';\nimport fastify from 'fastify';\n");
    fs.writeFileSync(path.join(fake, 'contract', 'http.ts'), "import fastify from 'fastify';\n");
    const violations = scanBoundary(fake);
    assert.ok(violations.some((line) => line.includes('plant') && line.includes('server')));
    assert.ok(violations.some((line) => line.includes('HTTP-библиотеку')));
    assert.equal(violations.some((line) => line.includes('use-core')), false);
    const command = spawnSync(process.execPath, ['--experimental-strip-types', path.join(root, 'contract', 'boundary.ts'), fake], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(command.status, 1, command.stdout);
    assert.match(command.stderr, /plant/);
    assert.equal(command.stderr.includes('use-core'), false);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});
