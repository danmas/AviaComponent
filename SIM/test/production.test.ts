import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStandInSpec, CONTRACT_STAND } from '../contract/stand.ts';
import { applyTearOff, pieces, summedPieces, transferred } from '../contract/quantity.ts';
import { createRng } from '../contract/rng.ts';
import { add, convert, quantity } from '../contract/units.ts';
import { completeOperation, launchBatch, passedPieces, receiveToWarehouse, startOperation, tearOffBatch } from '../plant/batch.ts';
import { ROUTE, scheduleOf } from '../plant/stand.ts';
import { addDowntime, at, createShop, operationVisibleInShop } from '../plant/state.ts';
import { instant } from '../contract/time.ts';

function mixedUnitsAreRejected(): void {
  const hours = quantity('norm-hour', 1);
  const machines = quantity('machine-hour', 1);
  // @ts-expect-error разные единицы не складываются
  add(hours, machines);
}

void mixedUnitsAreRejected;

test('параметры стенда лежат в диапазонах спецификации', () => {
  assertStandInSpec();
  assert.equal(CONTRACT_STAND.shiftHours, 12);
  assert.equal(CONTRACT_STAND.horizonShifts, 12);
  assert.equal(ROUTE.length, CONTRACT_STAND.routeLength);
  assert.deepEqual(ROUTE.map((step) => step.areaName), [
    'Токарная ЧПУ',
    'Фрезерная',
    'Термообработка',
    'Слесарная',
    'Испытательная',
    'Окончательный контроль',
    'Склад ГП',
  ]);
});

test('типы ресурсов планируются по правилу документа', () => {
  assert.equal(scheduleOf('machines'), 'queue');
  assert.equal(scheduleOf('furnaces'), 'charge-day');
  assert.equal(scheduleOf('personnel'), 'shift');
  assert.equal(scheduleOf('cooperation'), 'external-lead');
  const heat = ROUTE.find((step) => step.areaName === 'Термообработка');
  assert.equal(heat?.effort?.kind, 'charge-day');
  assert.equal(heat?.effort?.amount, 1);
  assert.equal(ROUTE.find((step) => step.areaName === 'Склад ГП')?.role.role, 'warehouse');
});

test('перевод единиц хранит основание', () => {
  const basis = {
    id: 'model-basis-1',
    from: 'norm-hour' as const,
    to: 'machine-hour' as const,
    factor: 0.8,
    sourceNote: 'гипотеза стенда, в документах коэффициента нет',
  };
  const result = convert(quantity('norm-hour', 10), basis);
  assert.equal(result.value.kind, 'machine-hour');
  assert.equal(result.value.amount, 8);
  assert.equal(result.basis.sourceNote, basis.sourceNote);
  assert.throws(() => convert(quantity('norm-hour', 10), { ...basis, sourceNote: '  ' }));
});

test('передача количества — сделано минус брак', () => {
  assert.equal(transferred(pieces(10), pieces(3)), 7);
  assert.throws(() => transferred(pieces(2), pieces(3)));
});

test('отрыв по ведомости не уменьшает родителя и не удваивает сумму', () => {
  const defect = applyTearOff(pieces(10), pieces(2), 'defect-sheet');
  assert.equal(defect.parentQty, 10);
  assert.equal(defect.childCountsApart, false);
  assert.equal(summedPieces([
    { qty: defect.parentQty, countsApart: true },
    { qty: defect.childQty, countsApart: defect.childCountsApart },
  ]), 10);

  const manual = applyTearOff(pieces(10), pieces(2), 'manual');
  assert.equal(manual.parentQty, 8);
  assert.equal(summedPieces([
    { qty: manual.parentQty, countsApart: true },
    { qty: manual.childQty, countsApart: manual.childCountsApart },
  ]), 10);
});

test('условия запуска: нет материала — операция не стартует', () => {
  const state = launchBatch(createShop(), {
    id: 'b',
    partId: 'p',
    qty: pieces(2),
    materialReady: false,
    designDocReady: true,
  });
  const first = state.operations.find((operation) => operation.sequence === 0);
  assert.ok(first);
  assert.equal(first.status, 'not-ready');
  assert.ok(first.missing.includes('material'));
  assert.throws(() => startOperation(state, first.id, 'area-cnc-turn-1'));
});

test('партия больше садки в печь не сажается', () => {
  let state = launchBatch(createShop(), {
    id: 'b',
    partId: 'p',
    qty: pieces(9),
    materialReady: true,
    designDocReady: true,
  });
  const turn = state.operations.find((operation) => operation.sequence === 0);
  assert.ok(turn);
  state = startOperation(state, turn.id, 'area-cnc-turn-1');
  state = completeOperation(state, turn.id, turn.planned, pieces(0));
  const mill = state.operations.find((operation) => operation.sequence === 1);
  assert.ok(mill);
  state = startOperation(state, mill.id, 'area-mill-1');
  state = completeOperation(state, mill.id, mill.planned, pieces(0));
  const heat = state.operations.find((operation) => operation.sequence === 2);
  assert.ok(heat);
  assert.equal(heat.planned, 9);
  assert.throws(() => startOperation(state, heat.id, 'area-heat-1'), /садки/);
});

test('сделано минус брак становится планом следующей операции', () => {
  let state = launchBatch(createShop(), {
    id: 'b',
    partId: 'p',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const first = state.operations.find((operation) => operation.sequence === 0);
  assert.ok(first);
  state = startOperation(state, first.id, 'area-cnc-turn-1');
  state = completeOperation(state, first.id, first.planned, pieces(1));
  assert.equal(passedPieces(state, first.id), 3);
  const next = state.operations.find((operation) => operation.sequence === 1);
  assert.equal(next?.planned, 3);
  assert.equal(next?.status, 'ready');
});

test('простой не пускает ресурс, вторая партия ждёт очередь станка', () => {
  let state = at(createShop(), instant(30));
  state = addDowntime(state, {
    id: 'down-1',
    resourceId: 'area-cnc-turn-1',
    from: instant(0),
    until: null,
    reason: 'breakdown',
  });
  state = launchBatch(state, {
    id: 'b1',
    partId: 'p',
    qty: pieces(1),
    materialReady: true,
    designDocReady: true,
  });
  const blocked = state.operations.find((operation) => operation.batchId === 'b1' && operation.sequence === 0);
  assert.ok(blocked);
  assert.throws(() => startOperation(state, blocked.id, 'area-cnc-turn-1'), /простое/);

  state = at(createShop(), instant(0));
  for (const id of ['b1', 'b2']) {
    state = launchBatch(state, {
      id,
      partId: 'p',
      qty: pieces(1),
      materialReady: true,
      designDocReady: true,
    });
  }
  const first = state.operations.find((operation) => operation.batchId === 'b1' && operation.sequence === 0);
  const second = state.operations.find((operation) => operation.batchId === 'b2' && operation.sequence === 0);
  assert.ok(first && second);
  state = startOperation(state, first.id, 'area-cnc-turn-1');
  assert.throws(() => startOperation(state, second.id, 'area-cnc-turn-1'), /занят/);
});

test('маршрут стенда доходит до склада, отрыв после старта запрещён', () => {
  const resources = [
    'area-cnc-turn-1',
    'area-mill-1',
    'area-heat-1',
    'area-bench-1',
    'area-test-1',
    'area-final-1',
  ];
  let state = launchBatch(createShop(), {
    id: 'b',
    partId: 'part-1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const started = startOperation(state, state.operations[0]?.id ?? '', resources[0] ?? '');
  assert.throws(() => tearOffBatch(started, 'b', 'b-child', pieces(1), 'manual'));

  for (let sequence = 0; sequence < resources.length; sequence += 1) {
    const operation = state.operations.find((item) => item.batchId === 'b' && item.sequence === sequence);
    assert.equal(operation?.status, 'ready');
    assert.ok(operation);
    state = startOperation(state, operation.id, resources[sequence] ?? '');
    state = completeOperation(state, operation.id, operation.planned, pieces(0));
  }
  const warehouse = state.operations.find((operation) => operation.sequence === 6);
  assert.equal(warehouse?.status, 'ready');
  assert.ok(warehouse);
  state = receiveToWarehouse(state, warehouse.id);
  assert.equal(state.operations.find((operation) => operation.id === warehouse.id)?.status, 'done');
  assert.equal(operationVisibleInShop(state, warehouse.id), true);
});

test('три основания отрыва на ещё не начатой партии', () => {
  function split(ground: 'batch-create' | 'defect-sheet' | 'manual') {
    const state = tearOffBatch(
      launchBatch(createShop(), {
        id: 'parent',
        partId: 'p',
        qty: pieces(10),
        materialReady: true,
        designDocReady: true,
      }),
      'parent',
      'child',
      pieces(4),
      ground,
    );
    return summedPieces(state.batches.map((batch) => ({ qty: batch.qty, countsApart: batch.countsApart })));
  }
  assert.equal(split('batch-create'), 10);
  assert.equal(split('manual'), 10);
  assert.equal(split('defect-sheet'), 10);
});

test('один seed даёт тот же отчёт, другой seed — другой', () => {
  function report(seed: number): string {
    const roll = createRng(seed)();
    let state = launchBatch(createShop(), {
      id: 'b',
      partId: 'p',
      qty: pieces(4),
      materialReady: true,
      designDocReady: true,
    });
    const first = state.operations.find((operation) => operation.sequence === 0);
    assert.ok(first);
    state = startOperation(state, first.id, 'area-cnc-turn-1');
    const scrap = pieces(Math.floor(roll * 3));
    state = completeOperation(state, first.id, first.planned, scrap);
    return JSON.stringify({ roll, good: passedPieces(state, first.id) });
  }
  assert.equal(report(20261126), report(20261126));
  assert.notEqual(report(1), report(2));
});
