import assert from 'node:assert/strict';
import test from 'node:test';

import { instant } from '../contract/time.ts';
import { launchBatch, tearOffBatch, completeOperation, startOperation } from '../plant/batch.ts';
import { createShop, type PlantState } from '../plant/state.ts';
import { pieces } from '../contract/quantity.ts';

function shopped(): PlantState {
  return { ...createShop(instant(0)), now: instant(0) };
}

test('первая операция готовой партии имеет нулевой момент готовности', () => {
  const state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const first = state.operations.find((operation) => operation.sequence === 0);
  assert.notEqual(first, undefined);
  assert.equal(first?.readyAt, 0, 'первая операция готова с нуля, а не null');
  assert.equal(first?.status, 'ready');
});

test('не готовая операция не имеет момента, и это не ноль', () => {
  const state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const second = state.operations.find((operation) => operation.sequence === 1);
  assert.notEqual(second, undefined);
  assert.equal(second?.readyAt, null, 'пока предыдущая не закрыта, момента нет');
  assert.equal(second?.status, 'not-ready');
  assert.notEqual(second?.readyAt, 0, 'null и ноль — разные вещи');
});

test('закрытые ворота не дают момента готовности', () => {
  const noMaterial = launchBatch(shopped(), {
    id: 'b2',
    partId: 'p2',
    qty: pieces(4),
    materialReady: false,
    designDocReady: true,
  });
  const first = noMaterial.operations.find((operation) => operation.sequence === 0);
  assert.equal(first?.status, 'not-ready');
  assert.equal(first?.readyAt, null, 'нет материала — момента нет');

  const noKd = launchBatch(shopped(), {
    id: 'b3',
    partId: 'p3',
    qty: pieces(4),
    materialReady: true,
    designDocReady: false,
  });
  const kdFirst = noKd.operations.find((operation) => operation.sequence === 0);
  assert.equal(kdFirst?.status, 'not-ready');
  assert.equal(kdFirst?.readyAt, null, 'нет КД — момента нет');
});

test('закрытие предыдущей ставит момент следующей точным временем, а не номером смены', () => {
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const first = state.operations.find((operation) => operation.sequence === 0);
  assert.notEqual(first, undefined);
  state = startOperation(state, 'b1-op-0', 'area-cnc-turn-1');
  state = { ...state, now: instant(1680) };
  state = completeOperation(state, 'b1-op-0', pieces(4), pieces(0));

  const second = state.operations.find((operation) => operation.sequence === 1);
  assert.equal(second?.status, 'ready');
  assert.equal(second?.readyAt, 1680, 'момент равен минуте закрытия, а не 2 или 3 смене');
});

test('момент ставится при снятии последнего условия, а не раньше', () => {
  // Синтетическое состояние: предыдущая закрыта, но материала нет.
  // Затем материал появляется — момент обязан стать моментом появления.
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: false,
    designDocReady: true,
  });
  const first = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(first?.readyAt, null);

  // Материал пришёл на минуте 600: ворота снимаются, партия готова.
  state = {
    ...state,
    now: instant(600),
    batches: state.batches.map((batch) => ({ ...batch, materialReady: true })),
  };
  // Прогоняем через те же ворота, что и ядро: операция ещё not-ready,
  // поэтому закрытие предыдущей (её нет) не участвует.
  const reopened = launchBatch(state, {
    id: 'b1b',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const fresh = reopened.operations.find((operation) => operation.batchId === 'b1b' && operation.sequence === 0);
  assert.equal(fresh?.readyAt, 600, 'момент равен минуте, в которую ворота открылись');
});

test('отрыв не переписывает момент готовности родителя', () => {
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const before = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(before?.readyAt, 0);

  state = { ...state, now: instant(300) };
  state = tearOffBatch(state, 'b1', 'b1-def', pieces(1), 'defect-sheet');

  const after = state.operations.find((operation) => operation.batchId === 'b1' && operation.sequence === 0);
  assert.equal(after?.readyAt, 0, 'момент родителя остался нулевым, а не стал 300');
  // Ведомость дефекта не уменьшает родителя: потомок уже входит в его количество.
  assert.equal(after?.planned, 4, 'количество родителя не изменилось по ведомости дефекта');
  assert.equal(state.batches.find((batch) => batch.id === 'b1')?.qty, 4, 'и сама партия тоже');
});

test('ручной отрыв уменьшает родителя и тоже не переписывает момент', () => {
  let state = launchBatch(shopped(), {
    id: 'b2',
    partId: 'p2',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  state = { ...state, now: instant(120) };
  state = tearOffBatch(state, 'b2', 'b2-part', pieces(2), 'manual');

  const parent = state.operations.find((operation) => operation.batchId === 'b2' && operation.sequence === 0);
  assert.equal(parent?.planned, 2, 'ручной отрыв уменьшает родителя');
  assert.equal(parent?.readyAt, 0, 'момент родителя прежний — он не начинал работу');
  const child = state.operations.find((operation) => operation.batchId === 'b2-part' && operation.sequence === 0);
  assert.equal(child?.readyAt, 120, 'дочерняя готова в момент отрыва');
});

test('отрыв ставит момент дочерним операциям по общему правилу', () => {
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  state = { ...state, now: instant(300) };
  state = tearOffBatch(state, 'b1', 'b1-def', pieces(1), 'defect-sheet');

  const childFirst = state.operations.find(
    (operation) => operation.batchId === 'b1-def' && operation.sequence === 0,
  );
  assert.notEqual(childFirst, undefined);
  assert.equal(childFirst?.readyAt, 300, 'первая операция дочерней готова в момент отрыва');
  const childSecond = state.operations.find(
    (operation) => operation.batchId === 'b1-def' && operation.sequence === 1,
  );
  assert.equal(childSecond?.readyAt, null, 'вторая ждёт предыдущую');
});

test('пролёживание выводится из момента: start − readyAt', () => {
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const op = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(op?.readyAt, 0);
  state = { ...state, now: instant(240) };
  state = startOperation(state, 'b1-op-0', 'area-cnc-turn-1');
  const started = state.operations.find((operation) => operation.id === 'b1-op-0');
  assert.equal(started?.status, 'running');
  assert.equal(started?.readyAt, 0, 'момент не изменился при запуске');
});

test('уровень empty: у партии без материала момента нет ни у одной операции', () => {
  const state = launchBatch(shopped(), {
    id: 'b5',
    partId: 'p5',
    qty: pieces(4),
    materialReady: false,
    designDocReady: true,
  });
  const ops = state.operations.filter((operation) => operation.batchId === 'b5');
  assert.ok(ops.length > 0);
  for (const operation of ops) {
    assert.equal(operation.readyAt, null, `у ${operation.id} не должно быть момента`);
  }
});

test('запуск ставит момент старта, и пролёживание перестаёт расти', () => {
  let state = launchBatch(shopped(), {
    id: 'b1',
    partId: 'p1',
    qty: pieces(4),
    materialReady: true,
    designDocReady: true,
  });
  const before = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(before?.readyAt, 0);
  assert.equal(before?.startedAt, null, 'до запуска старта нет');

  state = { ...state, now: instant(240) };
  state = startOperation(state, 'b1-op-0', 'area-cnc-turn-1');
  const started = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(started?.startedAt, 240, 'старт равен минуте запуска');
  assert.equal(started?.readyAt, 0, 'момент готовности не переписан');

  // Дальше минута цеха растёт, а пролёживание — нет.
  state = { ...state, now: instant(6000) };
  const later = state.operations.find((operation) => operation.sequence === 0);
  assert.equal(later?.startedAt, 240, 'старт неизменен при движении времени');
  assert.equal(later?.readyAt, 0, 'момент готовности неизменен');
});
