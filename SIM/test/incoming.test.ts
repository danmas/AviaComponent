import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../api/server.ts';
import { createRng } from '../contract/rng.ts';
import { pieces } from '../contract/quantity.ts';
import { SHIFT_MINUTES } from '../contract/time.ts';
import { launchBatch } from '../plant/batch.ts';
import { runShop, type ShopRun } from '../plant/engine.ts';
import { createShop } from '../plant/state.ts';
import { INCOMING_ARRIVAL, INCOMING_DUE, ordersFor } from '../run/catalog.ts';
import { EXPECTED } from '../run/levels.ts';
import { runStand, type RunResult } from '../run/run.ts';
import { waitingOf } from '../ui/src/lib/waiting.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function eventAt(events: readonly unknown[], type: string, orderId: string): number | undefined {
  for (const event of events) {
    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const row = event as { type?: string; orderId?: string; recordedAt?: number };
    if (row.type === type && row.orderId === orderId) {
      return row.recordedAt;
    }
  }
  return undefined;
}

function warehouseAt(run: RunResult): number | null {
  const rows = run.report.shopCompletions.filter(
    (row) => row.operationId === 'batch-7-op-6' && row.warehouse,
  );
  if (rows.length === 0) {
    return null;
  }
  return Math.max(...rows.map((row) => row.at));
}

test('стартовые заказы приходят в ноль и приняты каталогом, не временем', () => {
  const orders = ordersFor('clean', 'none');
  assert.equal(orders.length, 4);
  for (const order of orders) {
    assert.equal(order.arrivesAt, 0);
    assert.equal(order.acceptedByDefault, true);
  }
  const run = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 1 });
  assert.equal(run.shop.batches.length, 6);
  for (const batch of run.shop.batches) {
    assert.equal(batch.appearedAt, 0);
  }
  assert.equal(run.decisionJournal.length, 0);
});

test('до минуты поступления заказа нет, с неё он неразобранный и без партий', () => {
  const before = runStand({ seed: 42, level: 'clean', overlay: 'incoming', horizonShifts: 4 });
  const after = runStand({ seed: 42, level: 'clean', overlay: 'incoming', horizonShifts: 5 });
  const plain = runStand({ seed: 42, level: 'clean', overlay: 'none', horizonShifts: 5 });
  assert.equal(before.records.orders.some((order) => order.id === 'order-5'), false);
  assert.equal(before.shop.batches.some((batch) => batch.id === 'batch-7'), false);
  const order = after.records.orders.find((item) => item.id === 'order-5');
  assert.equal(order?.status, 'unparsed');
  assert.equal(order?.contractDue, INCOMING_DUE);
  assert.equal(after.shop.batches.some((batch) => batch.id === 'batch-7'), false);
  assert.equal(after.decisionJournal.length, 0);
  assert.equal(eventAt(after.contractEvents, 'order-registered', 'order-5'), INCOMING_ARRIVAL);
  assert.ok(after.report.metrics.portfolio.coverage < plain.report.metrics.portfolio.coverage);
  assert.ok(after.report.metrics.portfolio.coverage <= 1);
  assert.equal(after.report.expected.marks, EXPECTED.marks);
  assert.equal(after.report.expected.marks, 36);
  const plan = after.versions[4]?.orderDue.find((row) => row.orderId === 'order-5');
  assert.notEqual(plan, undefined);
  assert.notEqual(plan?.calculatedDue, null);
  assert.ok((plan?.calculatedDue ?? 0) > INCOMING_DUE);
  assert.deepEqual(
    after.records.orders.filter((item) => item.id !== 'order-5').map((item) => [item.id, item.contractDue, item.status]),
    plain.records.orders.map((item) => [item.id, item.contractDue, item.status]),
  );
});

test('приём запускает партию, отказ и молчание — нет', () => {
  const choice = { orderId: 'order-5', at: INCOMING_ARRIVAL, basisMetric: 'portfolio' as const };
  const accepted = runStand({
    seed: 42,
    level: 'clean',
    overlay: 'incoming',
    horizonShifts: 5,
    orderChoices: [{ ...choice, type: 'accept-order' }],
  });
  const deferred = runStand({
    seed: 42,
    level: 'clean',
    overlay: 'incoming',
    horizonShifts: 5,
    orderChoices: [{ ...choice, type: 'defer-order' }],
  });
  const silent = runStand({ seed: 42, level: 'clean', overlay: 'incoming', horizonShifts: 5 });
  const batch = accepted.shop.batches.find((item) => item.id === 'batch-7');
  const first = accepted.shop.operations.find((item) => item.id === 'batch-7-op-0');
  assert.equal(batch?.appearedAt, INCOMING_ARRIVAL);
  assert.equal(first?.areaId, 'area-cnc-turn');
  assert.equal(first?.readyAt, INCOMING_ARRIVAL);
  assert.notEqual(first?.status, 'not-ready');
  assert.ok(accepted.report.shifts[4]?.shopReady.includes('batch-7-op-0'));
  assert.equal(accepted.records.orders.find((item) => item.id === 'order-5')?.status, 'in-production');
  assert.equal(accepted.report.metrics.portfolio.coverage, 1);
  assert.equal(accepted.decisionJournal.length, 1);
  assert.equal(accepted.decisionJournal[0]?.at, INCOMING_ARRIVAL);
  assert.equal(accepted.decisionJournal[0]?.basisMetric, 'portfolio');
  assert.equal(deferred.shop.batches.some((item) => item.id === 'batch-7'), false);
  assert.equal(deferred.records.orders.find((item) => item.id === 'order-5')?.status, 'unparsed');
  assert.equal(deferred.report.metrics.portfolio.coverage, silent.report.metrics.portfolio.coverage);
  assert.equal(deferred.decisionJournal.length, 1);
  assert.equal(deferred.decisionJournal[0]?.at, INCOMING_ARRIVAL);
  assert.equal(deferred.decisionJournal[0]?.basisMetric, 'portfolio');
  assert.equal(silent.decisionJournal.length, 0);
  const op = first;
  assert.ok(op);
  assert.ok(op.startedAt === null || op.startedAt >= INCOMING_ARRIVAL);
  const waited = waitingOf({
    status: op.status,
    readyAt: op.readyAt,
    startedAt: op.startedAt,
    now: accepted.shop.now,
  });
  assert.ok(waited.minutes <= accepted.shop.now - INCOMING_ARRIVAL);
});

test('без ранга новая партия не обгоняет старшую, ранг поднимает', () => {
  const fresh = (id: string) => ({
    id,
    partId: 'part-1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  let shop = createShop();
  shop = launchBatch(shop, fresh('batch-old-a'));
  shop = launchBatch(shop, fresh('batch-old-b'));
  const dueByBatch = new Map<string, number | null>([
    ['batch-old-a', 9000],
    ['batch-old-b', 8000],
    ['batch-new', 100],
  ]);
  function turnStarts(run: ShopRun): { operationId: string; at: number }[] {
    return run.starts
      .filter((start) => start.resourceId === 'area-cnc-turn-1')
      .map((start) => ({ operationId: start.operationId, at: start.at }));
  }
  const queued = runShop({
    shop,
    dueByBatch,
    rng: createRng(1),
    controlRng: createRng(1),
    controlEnabled: false,
    horizonShifts: 2,
    launches: [{ at: 240, due: 100, batch: fresh('batch-new') }],
  });
  const order = turnStarts(queued);
  assert.equal(order[0]?.operationId, 'batch-old-b-op-0');
  assert.equal(order[0]?.at, 0);
  assert.equal(order[1]?.operationId, 'batch-old-a-op-0');
  assert.equal(order[1]?.at, 240);
  const lateStart = queued.starts.find((start) => start.operationId === 'batch-new-op-0');
  assert.ok(lateStart);
  assert.ok(lateStart.at > 240);
  assert.equal(queued.shop.batches.find((batch) => batch.id === 'batch-new')?.appearedAt, 240);
  assert.equal(queued.shop.batches.find((batch) => batch.id === 'batch-old-a')?.appearedAt, 0);
  const lifted = runShop({
    shop,
    dueByBatch,
    rng: createRng(1),
    controlRng: createRng(1),
    controlEnabled: false,
    horizonShifts: 2,
    launches: [{ at: 240, due: 100, batch: fresh('batch-new') }],
    priority: [{ batchId: 'batch-new', rank: 0, appliedAt: 240 }],
  });
  const liftedOrder = turnStarts(lifted);
  assert.equal(liftedOrder[1]?.operationId, 'batch-new-op-0');
  assert.equal(liftedOrder[1]?.at, 240);
});

test('помеха incoming не меняет прогон без неё и не добавляет эталон', () => {
  const names = fs.readdirSync(path.join(root, 'test', 'fixtures')).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, [
    'run-clean-none-20261126.json',
    'run-empty-none-20261126.json',
    'run-late-none-20261126.json',
    'run-paper-none-20261126.json',
  ]);
  const incoming = ordersFor('clean', 'incoming');
  assert.equal(incoming.length, 5);
  assert.deepEqual(
    incoming.slice(0, 4).map((order) => [order.id, order.contractDue, order.batchIds.join(',')]),
    ordersFor('clean', 'none').map((order) => [order.id, order.contractDue, order.batchIds.join(',')]),
  );
  const obstacle = incoming[4];
  assert.equal(obstacle?.id, 'order-5');
  assert.deepEqual(obstacle?.batchIds, ['batch-7']);
  assert.equal(obstacle?.arrivesAt, INCOMING_ARRIVAL);
  assert.equal(obstacle?.contractDue, INCOMING_DUE);
  assert.equal(obstacle?.acceptedByDefault, false);
});

test('замер: принятый заказ со сроком в две смены без приоритета опаздывает', () => {
  const accept = [{ type: 'accept-order' as const, orderId: 'order-5', at: INCOMING_ARRIVAL, basisMetric: 'portfolio' as const }];
  const plain = runStand({
    seed: 42,
    level: 'clean',
    overlay: 'incoming',
    orderChoices: accept,
  });
  const rushed = runStand({
    seed: 42,
    level: 'clean',
    overlay: 'incoming',
    orderChoices: accept,
    priority: [{ batchId: 'batch-7', rank: 0, appliedAt: INCOMING_ARRIVAL }],
  });
  const lateAt = warehouseAt(plain);
  const rushAt = warehouseAt(rushed);
  assert.ok(lateAt !== null && lateAt > INCOMING_DUE, `без приоритета финиш ${String(lateAt)}, срок ${INCOMING_DUE}`);
  assert.ok(rushAt !== null && rushAt > INCOMING_DUE, `с приоритетом финиш ${String(rushAt)}, срок ${INCOMING_DUE}`);
  assert.ok(rushAt < lateAt, 'ранг сдвигает финиш раньше, но две смены короче маршрута');
});

test('экранные действия принять и отложить пишут журнал', async () => {
  const app = await buildApp();
  try {
    const unknownSession = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { seed: 42, level: 'clean', overlay: 'incoming' },
    });
    const unknownId = (unknownSession.json() as { id: string }).id;
    const unknown = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${unknownId}/decisions`,
      payload: { type: 'speed', batchId: 'batch-3', rank: 0 },
    });
    assert.equal(unknown.statusCode, 400);
    assert.match((unknown.json() as { error: string }).error, /priority/);
    assert.match((unknown.json() as { error: string }).error, /accept-order/);
    const early = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${unknownId}/decisions`,
      payload: { type: 'accept-order', orderId: 'order-5' },
    });
    assert.equal(early.statusCode, 409);

    async function reach(id: string): Promise<void> {
      for (let step = 0; step < 4; step += 1) {
        const advanced = await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
        assert.equal(advanced.statusCode, 200);
      }
    }
    await reach(unknownId);
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${unknownId}/decisions`,
      payload: { type: 'accept-order', orderId: 'order-5' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const journal = (accepted.json() as { journal: { at: number; basisMetric: string } }).journal;
    assert.equal(journal.at, INCOMING_ARRIVAL);
    assert.equal(journal.basisMetric, 'portfolio');
    const shop = await app.inject({ method: 'GET', url: `/v1/sessions/${unknownId}/shop` });
    const batches = (shop.json() as { reality: { batches: { id: string; appearedAt: number }[] } }).reality.batches;
    assert.equal(batches.find((batch) => batch.id === 'batch-7')?.appearedAt, INCOMING_ARRIVAL);
    const roles = await app.inject({ method: 'GET', url: `/v1/sessions/${unknownId}/roles` });
    const orders = (roles.json() as { records: { kind: string; ref: string; status?: string }[] }).records;
    assert.equal(orders.find((row) => row.kind === 'order' && row.ref === 'order-5')?.status, 'in-production');

    const deferSession = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { seed: 42, level: 'clean', overlay: 'incoming' },
    });
    const deferId = (deferSession.json() as { id: string }).id;
    await reach(deferId);
    const deferred = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${deferId}/decisions`,
      payload: { type: 'defer-order', orderId: 'order-5' },
    });
    assert.equal(deferred.statusCode, 200, deferred.body);
    const deferJournal = (deferred.json() as { journal: { at: number; basisMetric: string } }).journal;
    assert.equal(deferJournal.at, INCOMING_ARRIVAL);
    assert.equal(deferJournal.basisMetric, 'portfolio');
    const deferredShop = await app.inject({ method: 'GET', url: `/v1/sessions/${deferId}/shop` });
    const deferredBatches = (deferredShop.json() as { reality: { batches: { id: string }[] } }).reality.batches;
    assert.equal(deferredBatches.some((batch) => batch.id === 'batch-7'), false);
    const deferredRoles = await app.inject({ method: 'GET', url: `/v1/sessions/${deferId}/roles` });
    const deferredOrders = (deferredRoles.json() as { records: { kind: string; ref: string; status?: string }[] }).records;
    assert.equal(deferredOrders.find((row) => row.kind === 'order' && row.ref === 'order-5')?.status, 'unparsed');
  } finally {
    await app.close();
  }
});
