import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import { bottleneckOf, flowOf, hoursOf, waitMinutes } from '../src/lib/flow.ts';
import { waitingOf, waitingText } from '../src/lib/waiting.ts';

type Shop = any;

async function shopAt(shift: number): Promise<Shop> {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    const id = (created.json() as { id: string }).id;
    for (let step = 0; step < shift; step += 1) {
      await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
    }
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop`) });
    assert.equal(shop.statusCode, 200, shop.body);
    return (shop.json() as { reality: unknown }).reality;
  } finally {
    await app.close();
  }
}

test('не готовая операция не показывает пролёживание ноль', () => {
  const waiting = waitingOf({ status: 'not-ready', readyAt: null, startedAt: null, now: 5000 });
  assert.equal(waiting.state, 'not-ready');
  assert.equal(waitingText(waiting), 'ещё не готова');
  assert.equal(waitingText(waiting).includes('0'), false, 'нуля в тексте быть не должно');
});

test('ожидающая операция показывает, сколько лежит', () => {
  const waiting = waitingOf({ status: 'ready', readyAt: 1680, startedAt: null, now: 7680 });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.minutes, 6000);
  assert.equal(waiting.hours, 100);
  assert.equal(waitingText(waiting), 'лежит 6000 мин (100 ч)');
});

test('у работающей операции ожидание закончилось и не растёт', () => {
  const atStart = waitingOf({ status: 'running', readyAt: 1680, startedAt: 7680, now: 7680 });
  const later = waitingOf({ status: 'running', readyAt: 1680, startedAt: 7680, now: 12000 });
  assert.equal(atStart.state, 'finished');
  assert.equal(atStart.minutes, 6000);
  assert.equal(later.minutes, 6000, 'текущая минута не входит в расчёт');
  assert.equal(waitingText(later), 'пролежала 6000 мин (100 ч)');
});

test('часы считаются с одним знаком', () => {
  assert.equal(hoursOf(6000), 100);
  assert.equal(hoursOf(1133), 18.9);
  assert.equal(hoursOf(0), 0);
});

test('минуты ожидания операции: null у неготовой, число у остальных', () => {
  assert.equal(waitMinutes({ status: 'not-ready', readyAt: null, startedAt: null } as never, 100), null);
  assert.equal(waitMinutes({ status: 'ready', readyAt: 100, startedAt: null } as never, 400), 300);
  assert.equal(waitMinutes({ status: 'running', readyAt: 100, startedAt: 250 } as never, 900), 150);
});

test('узкое место по сумме, а не по числу ожидающих', () => {
  const loads = [
    { id: 'many-short', order: 0, sumMinutes: 50, waitingCount: 5 },
    { id: 'few-long', order: 1, sumMinutes: 6000, waitingCount: 2 },
  ];
  assert.equal(bottleneckOf(loads), 'few-long');
});

test('полное равенство разрешается порядком в маршруте', () => {
  const loads = [
    { id: 'second', order: 2, sumMinutes: 100, waitingCount: 1 },
    { id: 'first', order: 1, sumMinutes: 100, waitingCount: 1 },
  ];
  assert.equal(bottleneckOf(loads), 'first', 'порядок перебора не должен влиять');
  // Меняем порядок в массиве — ответ тот же.
  assert.equal(bottleneckOf([...loads].reverse()), 'first');
});

test('нет ожидания — нет узкого места', () => {
  assert.equal(bottleneckOf([{ id: 'a', order: 0, sumMinutes: 0, waitingCount: 0 }]), null);
  assert.equal(bottleneckOf([]), null);
});

test('схема: семь узлов по порядку маршрута', async () => {
  const shop = await shopAt(0);
  const flow = flowOf(shop);
  assert.equal(flow.nodes.length, 7);
  assert.deepEqual(
    flow.nodes.map((node: { id: string }) => node.id),
    ['area-cnc-turn', 'area-mill', 'area-heat', 'area-bench', 'area-test', 'area-final', 'area-fg'],
  );
  assert.equal(flow.links.length, 6, 'связей на одну меньше числа узлов');
});

test('число на связи равно очереди участка-источника', async () => {
  const shop = await shopAt(2);
  const flow = flowOf(shop);
  for (const link of flow.links) {
    const source = flow.nodes.find((node: { id: string }) => node.id === link.from);
    assert.ok(source, `узел ${link.from} есть на схеме`);
    assert.equal(
      link.waitingCount,
      source.waiting.length,
      `связь ${link.from}→${link.to} не совпала с очередью участка`,
    );
  }
});

test('узкое место там, где самое долгое ожидание', async () => {
  // На смене 2 печь держит самую большую очередь и самое долгое ожидание.
  const shop = await shopAt(2);
  const flow = flowOf(shop);
  assert.equal(flow.bottleneckId, 'area-heat', 'на смене 2 узкое место — печь');
  const heat = flow.nodes.find((node: { id: string }) => node.id === 'area-heat');
  assert.equal(heat?.isBottleneck, true);
  const marked = flow.nodes.filter((node: { isBottleneck: boolean }) => node.isBottleneck);
  assert.equal(marked.length, 1, 'узкое место одно');
});

test('позже узкое место переезжает туда, где копится ожидание', async () => {
  // После совместной садки печь держит очередь на сменах 1–3.
  // На смене 4 ждёт слесарная: узкое место ушло с термообработки.
  const shop = await shopAt(4);
  const flow = flowOf(shop);
  assert.equal(flow.bottleneckId, 'area-bench', 'на смене 4 узкое место — слесарная');
  const waitingNodes = flow.nodes.filter((node: { waiting: readonly unknown[] }) => node.waiting.length > 0);
  assert.ok(waitingNodes.length > 0, 'на смене 4 что-то ждёт');
});

test('свободный участок остаётся в схеме', async () => {
  const shop = await shopAt(0);
  const flow = flowOf(shop);
  const idle = flow.nodes.filter(
    (node: { waiting: readonly unknown[]; running: readonly unknown[] }) =>
      node.waiting.length === 0 && node.running.length === 0,
  );
  assert.ok(idle.length > 0, 'на смене 0 есть свободные участки');
  assert.equal(flow.nodes.length, 7, 'и они не исчезли из маршрута');
});

test('операции в срезе несут моменты готовности и старта', async () => {
  const shop = await shopAt(3);
  for (const operation of shop.operations) {
    if (operation.status === 'not-ready') {
      assert.equal(operation.readyAt, null, `у ${operation.id} не должно быть готовности`);
    } else {
      assert.notEqual(operation.readyAt, null, `у ${operation.id} должна быть готовность`);
    }
    // Склад принимает готовую продукцию без ресурса: у приёмки на складе
    // старта нет по устройству модели, и это не ошибка наблюдения.
    const warehouse = operation.areaId === 'area-fg';
    if ((operation.status === 'running' || operation.status === 'done') && !warehouse) {
      assert.notEqual(operation.startedAt, null, `у ${operation.id} должен быть старт`);
    }
    if (warehouse && operation.status === 'done') {
      assert.equal(operation.startedAt, null, 'склад принимает без ресурса, старта нет');
    }
  }
});

test('пролёживание склада: готовность есть, ожидание не считается', () => {
  // Склад — единственное место, где операция закрывается без старта.
  const waiting = waitingOf({ status: 'done', readyAt: 4320, startedAt: null, now: 7920 });
  assert.equal(waiting.state, 'not-ready', 'без старта ожидание не показывается как пролёжанное');
});

test('момент готовности не «плывёт» между сменами', async () => {
  const before = await shopAt(4);
  const after = await shopAt(5);
  let compared = 0;
  for (const operation of before.operations) {
    const later = after.operations.find((item: { id: string }) => item.id === operation.id);
    if (later === undefined || operation.readyAt === null) {
      continue;
    }
    assert.equal(later.readyAt, operation.readyAt, `готовность ${operation.id} изменилась между сменами`);
    compared += 1;
  }
  assert.ok(compared > 0, 'сравнение состоялось');
});
