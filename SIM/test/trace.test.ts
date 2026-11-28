import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../api/server.ts';
import { pathV1 } from '../api/version.ts';
import { runStand } from '../run/run.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const FIXTURE = path.join(root, 'test', 'fixtures', 'trace', 'clean-incoming-seed42.json');
const EXAMPLE = path.join(repo, 'docs', 'TRACE-EXAMPLE.json');
const RUN_FIXTURE = path.join(root, 'test', 'fixtures', 'run-clean-none-20261126.json');

/** Объём JSON следа без apiVersion. Замер clean/incoming, seed 42, 12 смен, без решений. */
const TRACE_BYTES = 29252;

interface TraceEvent {
  readonly at: number;
  readonly type: string;
  readonly orderId?: string;
  readonly contractDue?: number | null;
  readonly batchId?: string;
  readonly appearedAt?: number;
  readonly qty?: number;
  readonly operationId?: string;
  readonly areaId?: string;
  readonly readyAt?: number;
  readonly startedAt?: number;
  readonly done?: number;
  readonly good?: number;
  readonly decisionType?: string;
  readonly appliedAt?: number;
  readonly rank?: number | null;
}

interface TraceBody {
  readonly apiVersion: string;
  readonly meta: {
    readonly seed: number;
    readonly level: string;
    readonly overlay: string;
    readonly horizonShifts: number;
    readonly shiftMinutes: number;
    readonly note: string;
  };
  readonly events: readonly TraceEvent[];
  readonly frames: readonly {
    readonly shift: number;
    readonly at: number;
    readonly metrics: unknown;
    readonly batches: readonly unknown[];
  }[];
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function nestedKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      nestedKeys(item, found);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      nestedKeys(child, found);
    }
  }
}

function countOf(events: readonly TraceEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function traceBytes(body: string): number {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed['apiVersion'];
  return Buffer.byteLength(JSON.stringify(parsed));
}

async function play(input: {
  readonly seed: number;
  readonly level?: string;
  readonly overlay?: string;
  readonly decisions?: readonly { readonly shift: number; readonly body: Record<string, unknown> }[];
}): Promise<string> {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: input.seed, level: input.level ?? 'clean', overlay: input.overlay ?? 'incoming' },
    });
    assert.equal(created.statusCode, 201);
    const id = (created.json() as { id: string }).id;
    const pending = [...(input.decisions ?? [])];
    for (;;) {
      const view = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}`) })).json() as { currentShift: number };
      const now = pending.filter((decision) => decision.shift === view.currentShift);
      for (const decision of now) {
        const posted = await app.inject({
          method: 'POST',
          url: pathV1(`/sessions/${id}/decisions`),
          payload: decision.body,
        });
        assert.equal(posted.statusCode, 200, posted.body);
      }
      if (view.currentShift >= 11) {
        break;
      }
      const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
      assert.equal(advanced.statusCode, 200, advanced.body);
    }
    const response = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/trace`) });
    assert.equal(response.statusCode, 200, response.body);
    return response.body;
  } finally {
    await app.close();
  }
}

const reference = play({ seed: 42 });

test('прогон без запроса следа даёт прежний отчёт', () => {
  const run = runStand({ seed: 20261126, level: 'clean', overlay: 'none' });
  assert.equal(run.reportJson, fs.readFileSync(RUN_FIXTURE, 'utf8'));
  assert.equal(run.reportJson.includes('"frames"'), false);
});

test('шапка, порядок и набор полей совпадают с примером', async () => {
  const body = JSON.parse(await reference) as TraceBody;
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as TraceBody;
  assert.deepEqual(keysOf(body.meta), keysOf(example.meta));
  assert.equal(body.meta.seed, 42);
  assert.equal(body.meta.level, 'clean');
  assert.equal(body.meta.overlay, 'incoming');
  assert.equal(body.meta.horizonShifts, 12);
  assert.equal(body.meta.shiftMinutes, 720);
  assert.equal(body.meta.note, example.meta.note);
  for (let index = 1; index < body.events.length; index += 1) {
    const prev = body.events[index - 1];
    const next = body.events[index];
    assert.ok(prev !== undefined && next !== undefined);
    assert.ok(prev.at <= next.at);
  }
  const exampleKeys = new Map<string, string[]>();
  for (const event of example.events) {
    exampleKeys.set(event.type, keysOf(event));
  }
  for (const event of body.events) {
    const expected = exampleKeys.get(event.type);
    assert.ok(expected !== undefined, event.type);
    assert.deepEqual(keysOf(event), expected);
  }
  assert.deepEqual(keysOf(body.frames[0] ?? {}), keysOf(example.frames[0] ?? {}));
  assert.deepEqual(body.frames.slice(0, 4), example.frames.slice(0, 4));
});

test('на стенде пять заявок, шесть партий и замеренные числа событий', async () => {
  const body = JSON.parse(await reference) as TraceBody;
  assert.equal(body.events.length, 155);
  assert.equal(countOf(body.events, 'order-registered'), 5);
  assert.equal(countOf(body.events, 'batch-appeared'), 6);
  assert.equal(countOf(body.events, 'operation-ready'), 42);
  assert.equal(countOf(body.events, 'operation-started'), 36);
  assert.equal(countOf(body.events, 'operation-completed'), 66);
  assert.equal(countOf(body.events, 'decision-applied'), 0);
  assert.equal(body.frames.length, 12);
  assert.deepEqual(body.frames.map((frame) => frame.shift), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const batches = body.events.filter((event) => event.type === 'batch-appeared').map((event) => event.batchId);
  assert.deepEqual(batches, ['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5', 'batch-6']);
});

test('пролёживание — разница моментов, переход виден по двум событиям', async () => {
  const body = JSON.parse(await reference) as TraceBody;
  let positive = false;
  for (const started of body.events) {
    if (started.type !== 'operation-started') {
      continue;
    }
    const ready = body.events.find((event) => event.type === 'operation-ready' && event.operationId === started.operationId);
    assert.ok(ready !== undefined, started.operationId);
    assert.equal(ready.readyAt !== undefined, true);
    assert.equal(started.startedAt !== undefined, true);
    const wait = (started.startedAt ?? 0) - (ready.readyAt ?? 0);
    assert.ok(wait >= 0);
    if (wait > 0) {
      positive = true;
    }
  }
  assert.equal(positive, true);
  const first = body.events.find((event) => event.type === 'operation-ready' && event.operationId === 'batch-1-op-0');
  const closed = body.events.find((event) => event.type === 'operation-completed' && event.operationId === 'batch-1-op-0');
  const next = body.events.find((event) => event.type === 'operation-ready' && event.operationId === 'batch-1-op-1');
  assert.ok(first !== undefined && closed !== undefined && next !== undefined);
  assert.ok(body.events.indexOf(closed) < body.events.indexOf(next));
  assert.notEqual(first.areaId, next.areaId);
});

test('частичные закрытия дают несколько событий, годных не больше сделанных', async () => {
  const body = JSON.parse(await reference) as TraceBody;
  const byOperation = new Map<string, number>();
  for (const event of body.events) {
    if (event.type !== 'operation-completed') {
      continue;
    }
    assert.equal(typeof event.done, 'number');
    assert.equal(typeof event.good, 'number');
    assert.ok((event.good ?? 0) <= (event.done ?? 0));
    const id = event.operationId ?? '';
    byOperation.set(id, (byOperation.get(id) ?? 0) + 1);
  }
  assert.ok([...byOperation.values()].some((count) => count > 1));
});

test('кадр не содержит сырого состояния цеха', async () => {
  const body = JSON.parse(await reference) as TraceBody;
  const found = new Set<string>();
  nestedKeys(body.frames, found);
  for (const key of ['done', 'planned', 'readyAt', 'startedAt', 'operations', 'resources', 'downtimes', 'reality']) {
    assert.equal(found.has(key), false, key);
  }
});

test('другой seed даёт другой след, повтор — тот же', async () => {
  const first = await reference;
  const second = await play({ seed: 42 });
  const other = await play({ seed: 43 });
  assert.equal(second, first);
  assert.notEqual(other, first);
});

test('файл следа совпадает с ответом API', async () => {
  const body = await reference;
  assert.equal(fs.readFileSync(FIXTURE, 'utf8'), body);
  assert.equal(traceBytes(body), TRACE_BYTES);
});

test('приём заказа пишет решение и партию в минуту приёма', async () => {
  const body = JSON.parse(await play({
    seed: 42,
    decisions: [{ shift: 4, body: { type: 'accept-order', orderId: 'order-5' } }],
  })) as TraceBody;
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as TraceBody;
  const decisionKeys = keysOf(example.events.find((event) => event.type === 'decision-applied') ?? {});
  const accepted = body.events.filter((event) => event.type === 'decision-applied' && event.decisionType === 'accept-order');
  assert.equal(accepted.length, 1);
  const event = accepted[0];
  assert.ok(event !== undefined);
  assert.deepEqual(keysOf(event), decisionKeys);
  assert.equal(event.batchId, 'batch-7');
  assert.equal(event.appliedAt, 2880);
  assert.equal(event.rank, null);
  const batch = body.events.find((item) => item.type === 'batch-appeared' && item.batchId === 'batch-7');
  assert.equal(batch?.appearedAt, 2880);
});

test('ранг на смене 5 не меняет события и кадры до неё', async () => {
  const base = JSON.parse(await reference) as TraceBody;
  const ranked = JSON.parse(await play({
    seed: 42,
    decisions: [{ shift: 5, body: { type: 'priority', batchId: 'batch-3', rank: 0 } }],
  })) as TraceBody;
  const before = 5 * 720;
  assert.deepEqual(
    ranked.events.filter((event) => event.at < before),
    base.events.filter((event) => event.at < before),
  );
  assert.deepEqual(
    ranked.frames.filter((frame) => frame.shift < 5),
    base.frames.filter((frame) => frame.shift < 5),
  );
  const decision = ranked.events.find((event) => event.type === 'decision-applied');
  assert.equal(decision?.decisionType, 'priority');
  assert.equal(decision?.batchId, 'batch-3');
  assert.equal(decision?.rank, 0);
  assert.equal(decision?.appliedAt, before);
});

test('неизвестная сессия не отдаёт след', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: pathV1('/sessions/missing/trace') });
    assert.equal(response.statusCode, 404);
    const session = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    const id = (session.json() as { id: string }).id;
    const view = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}`) })).json() as Record<string, unknown>;
    assert.equal('events' in view, false);
    assert.equal('frames' in view, false);
    const shop = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop`) })).json() as { layer: string };
    assert.equal(shop.layer, 'shop');
  } finally {
    await app.close();
  }
});
