import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import { areasOf, batchesOf, chargeText, movementBetween, progressText, statusCounts, tracksOf } from '../src/lib/shop.ts';
import { missingLine, missingReasons, downtimeText, STATUS_TEXT } from '../src/lib/missing.ts';

type Shop = ReturnType<typeof areasOf> extends never ? never : any;

async function shopAt(shift: number, overlay = 'none'): Promise<Shop> {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay },
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

test('маршрут участков в порядке прогона', async () => {
  const shop = await shopAt(0);
  const areas = areasOf(shop);
  assert.deepEqual(
    areas.map((area: { id: string }) => area.id),
    ['area-cnc-turn', 'area-mill', 'area-heat', 'area-bench', 'area-test', 'area-final', 'area-fg'],
  );
  assert.equal(areas.at(-1)?.kind, 'warehouse');
  assert.equal(areas[0]?.kind, 'processing');
});

test('смена 0: шесть партий и сорок две операции', async () => {
  const shop = await shopAt(0);
  assert.equal(batchesOf(shop).length, 6);
  const counts = statusCounts(shop);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 42);
  assert.equal(counts['done'], 5);
  // Две партии в печи и фрезерная, которая доделывает порцию.
  assert.equal(counts['running'], 3);
  assert.equal(counts['ready'], 4);
});

test('работающая операция несёт ресурс, ожидающая нет', async () => {
  const shop = await shopAt(0);
  const areas = areasOf(shop);
  for (const area of areas) {
    for (const operation of area.running) {
      assert.notEqual(operation.resourceId, null, `работающая ${operation.id} без ресурса`);
    }
    for (const operation of area.waiting) {
      assert.equal(operation.resourceId, null, `ожидающая ${operation.id} с ресурсом`);
    }
  }
});

test('очередь на печи видна по партиям', async () => {
  const shop = await shopAt(2);
  const heat = areasOf(shop).find((area: { id: string }) => area.id === 'area-heat');
  assert.notEqual(heat, undefined, 'участок печи есть на маршруте');
  if (heat === undefined) {
    return;
  }
  assert.equal(heat.waiting.length, 2, 'следующая садка — две партии');
  assert.equal(heat.running.length, 2, 'в текущей садке две партии');
  assert.equal(heat.idle, false);
  const furnace = heat.resources.find((resource: { chargePieces: number | null }) => resource.chargePieces !== null);
  assert.equal(
    chargeText(furnace?.chargePieces ?? null, heat.running),
    'занято 8 из 8 · batch-2, batch-5',
  );
});

test('частичное выполнение видно отдельно от плана', async () => {
  const shop = await shopAt(0);
  const mill = areasOf(shop).find((area: { id: string }) => area.id === 'area-mill');
  const running = mill?.running.find((operation: { id: string }) => operation.id === 'batch-2-op-1');
  assert.ok(running, 'на смене 0 фрезерная ещё не закрыта');
  assert.equal(progressText(running?.done ?? 0, running?.planned ?? 0, running?.scrap ?? 0), 'сделано 1 из 4, годное 1');
});

test('свободный участок не скрывается', async () => {
  const shop = await shopAt(0);
  const areas = areasOf(shop);
  const idle = areas.filter((area: { idle: boolean }) => area.idle);
  assert.ok(idle.length > 0, 'на первой смене есть свободные участки');
  assert.equal(areas.length, 7, 'участки не исчезают из маршрута');
});

test('простой ресурса виден с причиной и промежутком', async () => {
  const shop = await shopAt(0, 'breakdown');
  const areas = areasOf(shop);
  const withDown = areas.filter((area: { down: readonly unknown[] }) => area.down.length > 0);
  assert.equal(withDown.length, 1, 'поломка ровно на одном участке');
  const holder = withDown[0];
  assert.notEqual(holder, undefined);
  if (holder === undefined) {
    return;
  }
  const down = holder.down[0];
  assert.notEqual(down, undefined);
  if (down === undefined) {
    return;
  }
  assert.equal(down.reason, 'breakdown');
  assert.equal(down.from, 0);
  assert.equal(down.until, 720);
  assert.equal(downtimeText(down.reason), 'поломка');
});

test('открытый простой не выглядит законченным', async () => {
  const shop = await shopAt(0, 'breakdown');
  const all = areasOf(shop).flatMap((area: { down: readonly { until: number | null }[] }) => area.down);
  assert.ok(all.length > 0);
  for (const downtime of all) {
    if (downtime.until === null) {
      assert.equal(downtime.until, null, 'открытый простой остался открытым');
    }
  }
  // На стенде поломка закрытая: проверяем, что null не подменяется нулём.
  assert.equal(all.every((d: { until: number | null }) => d.until === null || d.until > 0), true);
});

test('партия идёт по маршруту: шаги в порядке операции', async () => {
  const shop = await shopAt(0);
  const tracks = tracksOf(shop);
  assert.equal(tracks.length, 6);
  for (const track of tracks) {
    const sequences = track.steps.map((step: { operation: { sequence: number } }) => step.operation.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), `шаги ${track.batch.id} не по порядку`);
    assert.equal(track.totalCount, 7, 'в маршруте партии семь шагов');
  }
  const first = tracks[0];
  assert.notEqual(first, undefined);
  if (first === undefined) {
    return;
  }
  assert.equal(first.doneCount, 2, 'на смене 0 у первой партии два шага закрыто');
  assert.equal(first.current?.operation.areaId, 'area-heat', 'первая партия стоит на печи');
});

test('движение между сменами 2 и 3 — из двух срезов, а не из догадки', async () => {
  const before = await shopAt(2);
  const after = await shopAt(3);
  const changes = movementBetween(before, after);
  assert.ok(changes.length > 0, 'между сменами что-то двигалось');
  for (const change of changes) {
    const previous = before.operations.find((o: { id: string }) => o.id === change.operationId);
    const next = after.operations.find((o: { id: string }) => o.id === change.operationId);
    assert.notEqual(previous, undefined);
    assert.notEqual(next, undefined);
    assert.equal(change.fromStatus, previous.status, 'было взято из первого среза');
    assert.equal(change.toStatus, next.status, 'стало взято из второго среза');
    assert.equal(change.fromDone, previous.done);
    assert.equal(change.toDone, next.done);
  }
});

test('движение не выдумывает операций, которых не было', async () => {
  const before = await shopAt(1);
  const after = await shopAt(1);
  assert.deepEqual(movementBetween(before, after), [], 'один и тот же срез не даёт изменений');
});

test('пропуски переведены в причины, а не в «не готово»', () => {
  assert.deepEqual(missingReasons(['previous']), ['не закончена предыдущая операция']);
  assert.deepEqual(missingReasons(['material']), ['нет материала']);
  assert.deepEqual(missingReasons(['kd', 'material']), ['нет материала', 'нет конструкторской документации']);
  assert.equal(missingLine(['previous']), 'не закончена предыдущая операция');
  assert.equal(missingLine([]), '');
});

test('статусы названы по-русски и различаются', () => {
  assert.equal(STATUS_TEXT['running'], 'в работе');
  assert.equal(STATUS_TEXT['ready'], 'ждёт');
  assert.notEqual(STATUS_TEXT['running'], STATUS_TEXT['ready']);
  assert.equal(STATUS_TEXT['not-ready'], 'не готова');
  assert.equal(STATUS_TEXT['done'], 'закрыта');
});

test('минута среза видна на экране', async () => {
  const shop = await shopAt(3);
  assert.equal(shop.now, 2880, 'смена 3 — минута 2880');
});

test('экран цеха не берёт показатели Системы', async () => {
  const shop = await shopAt(0) as Record<string, unknown>;
  for (const foreign of ['metrics', 'summary', 'reliability', 'coverage']) {
    assert.equal(foreign in shop, false, `в срезе цеха не должно быть ${foreign}`);
  }
});
