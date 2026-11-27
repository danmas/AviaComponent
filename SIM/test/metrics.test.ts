import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { importViolation, scanBoundary } from '../contract/boundary.ts';
import { pieces } from '../contract/quantity.ts';
import { instant, shiftWindow } from '../contract/time.ts';
import { quantity } from '../contract/units.ts';
import { launchBatch, startOperation, completeOperation } from '../plant/batch.ts';
import { createShop, operationVisibleInShop } from '../plant/state.ts';
import { recordedGood } from '../system/card.ts';
import {
  acceptedShift,
  fourMetrics,
  portfolio,
  scheduleRisk,
  systemSeesOperation,
} from '../system/metrics.ts';
import { emptyRecords, type SystemRecords } from '../system/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function records(): SystemRecords {
  return {
    orders: [
      { id: 'o1', status: 'in-production', contractDue: instant(1000) },
      { id: 'o2', status: 'in-production', contractDue: null },
      { id: 'o3', status: 'archive', contractDue: instant(100) },
    ],
    norms: [
      { orderId: 'o1', operationId: null, norm: quantity('norm-hour', 10) },
      { orderId: 'o1', operationId: 'op-1', norm: quantity('norm-hour', 4) },
    ],
    facts: [
      { id: 'f1', orderId: 'o1', operationId: 'op-1', author: 'master', trueTime: instant(100), recordTime: instant(100) },
      { id: 'f2', orderId: 'o1', operationId: 'op-1', author: 'worker', trueTime: instant(100), recordTime: instant(110) },
      { id: 'f3', orderId: 'o1', operationId: 'op-2', author: 'worker', trueTime: instant(200), recordTime: instant(800) },
    ],
    areaLoads: [
      {
        areaId: 'mill',
        areaName: 'Фрезерная',
        capacity: quantity('norm-hour', 224),
        plan: quantity('norm-hour', 224),
        queue: quantity('norm-hour', 10),
      },
      {
        areaId: 'heat',
        areaName: 'Термообработка',
        capacity: quantity('charge-day', 1),
        plan: quantity('machine-hour', 2),
        queue: quantity('charge-day', 1),
      },
    ],
    planDates: [
      { orderId: 'o1', versionId: 'v1', createdAt: instant(1), calculatedDue: instant(500) },
      { orderId: 'o1', versionId: 'v2', createdAt: instant(2), calculatedDue: instant(1500) },
    ],
    cards: [],
  };
}

test('подмена цеха и истинного времени не меняет показатели', () => {
  const data = records();
  const window = shiftWindow(0, 12);
  const level = { orders: 2, areas: 2, shiftFacts: 2 };
  const before = JSON.stringify(fourMetrics(data, level, window));

  let shop = launchBatch(createShop(), {
    id: 'hidden',
    partId: 'p',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const hidden = shop.operations[0];
  assert.ok(hidden);
  shop = startOperation(shop, hidden.id, 'area-cnc-turn-1');
  shop = completeOperation(shop, hidden.id, hidden.planned, pieces(3));
  assert.equal(operationVisibleInShop(shop, hidden.id), true);
  assert.equal(systemSeesOperation(data, hidden.id), false);

  const shifted: SystemRecords = {
    ...data,
    facts: data.facts.map((fact) => ({ ...fact, trueTime: instant(9000) })),
  };
  assert.equal(JSON.stringify(fourMetrics(data, level, window)), before);
  assert.equal(JSON.stringify(fourMetrics(shifted, level, window)), before);
  assert.equal(shop.now, 0);
});

test('портфель, смена по времени записи и риск по последней версии плана', () => {
  const data = records();
  const book = portfolio(data, 2);
  assert.equal(book.value.openCount, 2);
  assert.equal(book.value.ordersWithoutNorm, 1);
  assert.equal(book.value.remainderNormHours, 6);
  assert.equal(book.coverage, 0.5);
  assert.deepEqual(book.reads, ['orders', 'norms', 'facts']);

  const shift = acceptedShift(data, shiftWindow(0, 12), 2);
  assert.equal(shift.value.normHours, 4);
  assert.equal(shift.value.masterCloses, 1);
  assert.equal(shift.value.workerCloses, 0);
  assert.equal(shift.value.duplicateFacts, 1);
  const later = acceptedShift(data, shiftWindow(1, 12), 1);
  assert.equal(later.value.normHours, 0);
  assert.equal(later.value.workerCloses, 1);

  const risk = scheduleRisk(data, 2);
  assert.deepEqual(risk.value, { overdue: 1, onTime: 0, unevaluated: 1 });
  assert.equal(risk.coverage, 0.5);
});

test('очереди разных единиц не складываются в одно число', () => {
  const value = fourMetrics(records(), { orders: 2, areas: 2, shiftFacts: 1 }, shiftWindow(0, 12)).overload.value;
  assert.equal(value.overloadedCount, 2);
  assert.equal(value.areas[1]?.problem, 'unit-mismatch');
  assert.equal(value.areas[1]?.load, null);
  assert.deepEqual(value.queueByUnit, [
    { unit: 'charge-day', amount: 1 },
    { unit: 'norm-hour', amount: 10 },
  ]);
});

test('годные на карте считаются по записи карты', () => {
  assert.equal(recordedGood({
    operationId: 'op',
    technology: 'точение',
    production: null,
    control: null,
    totals: { done: pieces(5), scrap: pieces(2) },
  }), 3);
});

test('сборка ловит импорт цеха из Системы и сложение разных единиц', () => {
  assert.deepEqual(scanBoundary(root), []);
  assert.ok(importViolation(path.join(root, 'system', 'metrics.ts'), '../plant/state.ts'));
  assert.ok(importViolation(path.join(root, 'contract', 'events.ts'), '../plant/state.ts'));
  assert.equal(importViolation(path.join(root, 'system', 'metrics.ts'), '../contract/time.ts'), null);

  const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const compiled = spawnSync(process.execPath, [
    tsc,
    '--noEmit',
    '--strict',
    '--pretty',
    'false',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--allowImportingTsExtensions',
    path.join(root, 'fixtures', 'mixed-units.ts'),
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(compiled.status, 0);
  assert.match(`${compiled.stdout}\n${compiled.stderr}`, /machine-hour/);
});

test('ожидаемый объём покрытия не берётся из пустого прогона', () => {
  assert.throws(() => portfolio(emptyRecords(), 0));
});

test('неразобранный заказ не входит в числитель покрытия', () => {
  const data = records();
  const grown: SystemRecords = {
    ...data,
    orders: [...data.orders, { id: 'o-new', status: 'unparsed', contractDue: instant(50) }],
    norms: [...data.norms, { orderId: 'o-new', operationId: null, norm: quantity('norm-hour', 6) }],
  };
  const book = portfolio(grown, 3);
  assert.equal(book.value.openCount, 3);
  assert.equal(book.value.ordersWithoutNorm, 1);
  assert.equal(book.value.remainderNormHours, 6);
  assert.equal(book.coverage, 1 / 3);
  assert.ok(book.coverage <= 1);
});
