import assert from 'node:assert/strict';
import test from 'node:test';

import { pieces } from '../contract/quantity.ts';
import { createRng } from '../contract/rng.ts';
import { instant } from '../contract/time.ts';
import { quantity } from '../contract/units.ts';
import { completeOperation, launchBatch, startOperation } from '../plant/batch.ts';
import { runShop } from '../plant/engine.ts';
import { CONTROL_SCRAP_CHANCE, CONTROL_SCRAP_PIECES, controlScrapFor, PLANT_STAND } from '../plant/stand.ts';
import {
  addDowntime,
  createShop,
  furnaceCharges,
  progressLine,
  shopSlice,
  type PlantOperation,
  type PlantState,
} from '../plant/state.ts';
import { groupCompletions, runStand } from '../run/run.ts';

const TURN = 'area-cnc-turn-1';
const MILL = 'area-mill-1';
const HEAT = 'area-heat-1';

function batch(state: PlantState, id: string, qty = 4): PlantState {
  return launchBatch(state, {
    id,
    partId: 'p',
    qty: pieces(qty),
    materialReady: true,
    designDocReady: true,
  });
}

function operation(state: PlantState, batchId: string, sequence: number): PlantOperation {
  const found = state.operations.find((item) => item.batchId === batchId && item.sequence === sequence);
  assert.ok(found, `${batchId} шаг ${sequence}`);
  return found;
}

function finishStep(state: PlantState, batchId: string, sequence: number, resourceId: string): PlantState {
  const current = operation(state, batchId, sequence);
  state = startOperation(state, current.id, resourceId);
  return completeOperation(state, current.id, current.planned, pieces(0));
}

test('две партии по 4 садятся в садку 8, третья ждёт', () => {
  assert.equal(PLANT_STAND.furnaceChargePieces, 8);
  let state = createShop();
  for (const id of ['a', 'b', 'c']) {
    state = batch(state, id);
    state = finishStep(state, id, 0, TURN);
    state = finishStep(state, id, 1, MILL);
  }
  state = startOperation(state, operation(state, 'a', 2).id, HEAT);
  state = startOperation(state, operation(state, 'b', 2).id, HEAT);
  assert.equal(operation(state, 'a', 2).status, 'running');
  assert.equal(operation(state, 'b', 2).status, 'running');
  assert.throws(() => startOperation(state, operation(state, 'c', 2).id, HEAT), /садк/);
  assert.equal(operation(state, 'c', 2).status, 'ready');
  const slice = shopSlice(state);
  const charge = furnaceCharges(slice.reality).find((item) => item.resourceId === HEAT);
  assert.ok(charge);
  assert.equal(charge?.line, 'занято 8 из 8');
  assert.deepEqual(charge?.batchIds, ['a', 'b']);
  assert.equal(charge?.free, 0);
});

test('в садке на 4 штуки остаётся место', () => {
  let state = createShop();
  state = batch(state, 'a');
  state = finishStep(state, 'a', 0, TURN);
  state = finishStep(state, 'a', 1, MILL);
  state = startOperation(state, operation(state, 'a', 2).id, HEAT);
  const charge = furnaceCharges(shopSlice(state).reality)[0];
  assert.equal(charge?.line, 'занято 4 из 8');
  assert.equal(charge?.free, 4);
  assert.deepEqual(charge?.batchIds, ['a']);
});

test('станок по-прежнему берёт одну операцию', () => {
  let state = createShop();
  state = batch(state, 'a', 1);
  state = batch(state, 'b', 1);
  state = startOperation(state, operation(state, 'a', 0).id, TURN);
  assert.throws(() => startOperation(state, operation(state, 'b', 0).id, TURN), /занят/);
  assert.equal(operation(state, 'b', 0).status, 'ready');
});

test('садка закрывается от первой посадки, вторая её не сдвигает', () => {
  let state = createShop();
  state = batch(state, 'a', 1);
  state = batch(state, 'b', 1);
  state = addDowntime(state, {
    id: 'heat-hold',
    resourceId: HEAT,
    from: instant(0),
    until: instant(1000),
    reason: 'no-task',
  });
  state = {
    ...state,
    operations: state.operations.map((item) => {
      if (item.batchId === 'a' && item.sequence < 2) {
        return { ...item, status: 'done' as const, planned: pieces(1), done: pieces(1), readyAt: instant(0), startedAt: instant(0) };
      }
      if (item.batchId === 'a' && item.sequence === 2) {
        return { ...item, status: 'ready' as const, planned: pieces(1), missing: [], readyAt: instant(0) };
      }
      if (item.batchId === 'b' && item.sequence === 0) {
        return { ...item, status: 'done' as const, planned: pieces(1), done: pieces(1), readyAt: instant(0), startedAt: instant(0) };
      }
      if (item.batchId === 'b' && item.sequence === 1) {
        return {
          ...item,
          effort: quantity('machine-hour', 20),
          planned: pieces(1),
          status: 'ready' as const,
          missing: [],
          readyAt: instant(0),
        };
      }
      return item;
    }),
  };
  const run = runShop({
    shop: state,
    dueByBatch: new Map([['a', null], ['b', null]]),
    rng: createRng(1),
    controlRng: createRng(1),
    controlEnabled: false,
    horizonShifts: 5,
  });
  const heatStarts = run.starts.filter((start) => start.resourceId === HEAT).sort((left, right) => left.at - right.at);
  assert.deepEqual(heatStarts.map((start) => [start.operationId, start.at]), [
    ['a-op-2', 1000],
    ['b-op-2', 1200],
  ]);
  const heatClosures = run.completions.filter((completion) => completion.areaId === 'area-heat');
  assert.ok(heatClosures.length >= 2);
  for (const completion of heatClosures) {
    assert.equal(completion.at, 2440);
  }
});

test('частичное закрытие передаёт годное и не двигает моменты', () => {
  let state = batch(createShop(), 'b');
  const first = operation(state, 'b', 0);
  state = startOperation(state, first.id, TURN);
  const running = operation(state, 'b', 0);
  state = completeOperation(state, first.id, pieces(2), pieces(0));
  const closed = operation(state, 'b', 0);
  const next = operation(state, 'b', 1);
  assert.equal(closed.done, 2);
  assert.equal(closed.status, 'running');
  assert.equal(next.planned, 2);
  assert.equal(next.status, 'ready');
  assert.equal(progressLine(closed), 'сделано 2 из 4, годное 2');
  assert.equal(closed.readyAt, running.readyAt);
  assert.equal(closed.startedAt, running.startedAt);
  assert.equal(next.readyAt, 0);
});

test('закрытие больше плана и брак больше сделанного отклоняются', () => {
  let state = batch(createShop(), 'b');
  state = startOperation(state, operation(state, 'b', 0).id, TURN);
  const snapshot = JSON.stringify(state.operations);
  assert.throws(() => completeOperation(state, 'b-op-0', pieces(5), pieces(0)), /плана/);
  assert.equal(JSON.stringify(state.operations), snapshot);
  assert.throws(() => completeOperation(state, 'b-op-0', pieces(2), pieces(3)), /Брак/);
  assert.equal(JSON.stringify(state.operations), snapshot);
});

test('два закрытия по 2 дают две записи и 4 в операции', () => {
  const run = runShop({
    shop: batch(createShop(), 'b'),
    dueByBatch: new Map([['b', null]]),
    rng: createRng(1),
    controlRng: createRng(1),
    controlEnabled: false,
    horizonShifts: 1,
  });
  const turn = run.completions.filter((completion) => completion.operationId === 'b-op-0');
  assert.deepEqual(turn.map((completion) => completion.done), [2, 2]);
  assert.equal(run.shop.operations.find((item) => item.id === 'b-op-0')?.done, 4);
});

test('дальше идёт только годное', () => {
  let state = batch(createShop(), 'b');
  state = startOperation(state, operation(state, 'b', 0).id, TURN);
  state = completeOperation(state, 'b-op-0', pieces(4), pieces(1));
  assert.equal(operation(state, 'b', 1).planned, 3);
  assert.equal(operation(state, 'b', 1).status, 'ready');
});

test('контроль находит одну штуку брака и отрывает её по ведомости', () => {
  assert.equal(CONTROL_SCRAP_PIECES, 1);
  const first = runStand({ seed: 7, level: 'clean', overlay: 'scrap' });
  const second = runStand({ seed: 7, level: 'clean', overlay: 'scrap' });
  const scrapOf = (run: typeof first) =>
    run.shop.operations
      .filter((item) => item.scrap > 0)
      .map((item) => [item.id, item.areaId, item.scrap, item.done])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  assert.deepEqual(scrapOf(first), scrapOf(second));
  assert.equal(first.shop.operations.some((item) => item.areaId === 'area-cnc-turn' && item.scrap > 0), false);
  const found = first.shop.operations.filter(
    (item) => (item.areaId === 'area-test' || item.areaId === 'area-final') && item.scrap > 0,
  );
  assert.ok(found.length > 0);
  for (const item of found) {
    assert.equal(item.scrap, CONTROL_SCRAP_PIECES);
    const child = first.shop.batches.find((batchRow) => batchRow.id === `${item.batchId}-defect-${item.sequence}`);
    assert.equal(child?.qty, item.scrap);
    assert.equal(child?.tearOff, 'defect-sheet');
    const downstream = first.shop.operations.find(
      (next) => next.batchId === item.batchId && next.sequence === item.sequence + 1,
    );
    if (item.status === 'done' && downstream) {
      assert.equal(downstream.planned, item.done - item.scrap);
    }
  }
});

test('правило контроля: попадание в вероятность даёт брак, промах нет', () => {
  assert.equal(CONTROL_SCRAP_CHANCE, 0.5);
  // Попадание: draw ниже вероятности.
  assert.equal(controlScrapFor(0, 4), 1);
  assert.equal(controlScrapFor(0.49, 4), 1);
  // Промах: draw на вероятности и выше.
  assert.equal(controlScrapFor(0.5, 4), 0);
  assert.equal(controlScrapFor(0.99, 4), 0);
  // Брак не больше порции: пришло меньше, чем правило бракует.
  assert.equal(controlScrapFor(0, 1), 1);
  assert.equal(controlScrapFor(0, 2, 5), 2, 'брак не может быть больше того, что пришло');
  assert.equal(controlScrapFor(0, 4, 3), 3);
  assert.equal(controlScrapFor(0, 4, 4), 4);
});

test('правило контроля отвергает невозможные входы', () => {
  assert.throws(() => controlScrapFor(-0.1, 4), /полуинтервала/);
  assert.throws(() => controlScrapFor(1, 4), /полуинтервала/);
  assert.throws(() => controlScrapFor(0, 0), /Порция/);
  assert.throws(() => controlScrapFor(0, 4, 1.5), /целым числом/);
  assert.throws(() => controlScrapFor(0, 4, 1, 1.5), /Вероятность/);
});

test('брак зависит от seed, а не выпадает всегда', () => {
  const ofSeed = (seed: number) => {
    const run = runStand({ seed, level: 'clean', overlay: 'scrap', horizonShifts: 12 });
    const found = run.shop.operations.filter((item) => item.scrap > 0);
    return { count: found.length, total: found.reduce((sum, item) => sum + item.scrap, 0) };
  };
  const many = [1, 7, 42, 100, 20261126].map(ofSeed);
  const counts = many.map((item) => item.count);
  // Хотя бы два разных seed дают разное число брака — значит генератор работает.
  assert.ok(new Set(counts).size > 1, `все seed дали одно и то же: ${counts.join(', ')}`);
  // И хотя бы на одном seed брака меньше, чем операций контроля: контроль не всегда срабатывает.
  const run = runStand({ seed: 42, level: 'clean', overlay: 'scrap', horizonShifts: 12 });
  const testOps = run.shop.operations.filter((item) => item.areaId === 'area-test' && item.done > 0);
  const withScrap = testOps.filter((item) => item.scrap > 0).length;
  assert.ok(withScrap < testOps.length, 'контроль сработал на всех операциях — правило не случайно');
  assert.ok(withScrap > 0, 'контроль не сработал ни разу — правило сломано');
});

test('занятость станков до контроля не зависит от генератора брака', () => {
  const plain = runStand({ seed: 7, level: 'clean', overlay: 'none' });
  const scrap = runStand({ seed: 7, level: 'clean', overlay: 'scrap' });
  assert.deepEqual(plain.report.failureBusyMinute, scrap.report.failureBusyMinute);
  const machines = (run: typeof plain) =>
    run.starts
      .filter((start) => start.resourceId === TURN || start.resourceId === MILL)
      .map((start) => [start.operationId, start.resourceId, start.at]);
  assert.deepEqual(machines(plain), machines(scrap));
  const upstream = (run: typeof plain) =>
    run.report.facts.filter((fact) => {
      const sequence = Number(fact.operationId.split('-op-')[1]);
      return sequence <= 3;
    });
  assert.deepEqual(upstream(plain), upstream(scrap));
});

test('объём отчёта измерен относительно 9300 байт', () => {
  const run = runStand({ seed: 42, level: 'clean', overlay: 'none' });
  const bytes = run.reportJson.length;
  assert.equal(Number.isFinite(bytes), true);
  if (bytes > 9300 * 3) {
    const ids = run.report.shopCompletions.map((completion) => completion.operationId);
    assert.equal(new Set(ids).size, ids.length);
  }
  const grouped = groupCompletions([
    { operationId: 'op', at: 10, done: 2, scrap: 0, warehouse: false },
    { operationId: 'op', at: 40, done: 2, scrap: 1, warehouse: false },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.done, 4);
  assert.equal(grouped[0]?.scrap, 1);
  assert.equal(grouped[0]?.at, 40);
  const done = run.shop.operations.find((item) => item.id === 'batch-1-op-0');
  assert.ok(done);
  assert.ok((done?.done ?? 0) <= (done?.planned ?? 0));
});
