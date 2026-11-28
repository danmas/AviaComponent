import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import {
  batchesAt,
  areasAt,
  frameAt,
  frameReadings,
  gameAt,
  nextEventMinute,
  ROUTE_STEPS,
  shiftStarts,
  spanOf,
  type Trace,
} from '../src/lib/game.ts';

const HORIZON = 12;

async function traceOf(options: {
  readonly decisions?: readonly { readonly shift: number; readonly body: Record<string, unknown> }[];
}): Promise<Trace> {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'incoming' },
    });
    const id = (created.json() as { id: string }).id;
    const pending = [...(options.decisions ?? [])];
    for (let shift = 0; shift < HORIZON; shift += 1) {
      if (shift > 0) {
        await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
      }
      for (const decision of pending.filter((row) => row.shift === shift)) {
        const applied = await app.inject({
          method: 'POST',
          url: pathV1(`/sessions/${id}/decisions`),
          payload: decision.body,
        });
        assert.equal(applied.statusCode, 200, applied.body);
      }
    }
    const trace = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/trace`) });
    assert.equal(trace.statusCode, 200);
    return trace.json() as Trace;
  } finally {
    await app.close();
  }
}

const reference = traceOf({});
const accepted = traceOf({
  decisions: [{ shift: 4, body: { type: 'accept-order', orderId: 'order-5' } }],
});

test('семь шагов маршрута и границы смен', async () => {
  const trace = await reference;
  assert.equal(ROUTE_STEPS.length, 7);
  const span = spanOf(trace);
  assert.equal(span.shiftMinutes, 720);
  assert.equal(span.shifts, 12);
  assert.equal(span.to, 8640);
  assert.deepEqual(shiftStarts(trace), [0, 720, 1440, 2160, 2880, 3600, 4320, 5040, 5760, 6480, 7200, 7920]);
});

test('кадр действует от своей границы до следующей', async () => {
  const trace = await reference;
  assert.equal(frameAt(trace, 0)?.shift, 0);
  assert.equal(frameAt(trace, 719)?.shift, 0);
  assert.equal(frameAt(trace, 720)?.shift, 1);
  assert.equal(frameAt(trace, 2880)?.shift, 4);
});

test('на нулевой минуте партии уже в цехе, но ничего не пролежало', async () => {
  const trace = await reference;
  const batches = batchesAt(trace, 0);
  assert.equal(batches.length, 6);
  for (const batch of batches) {
    assert.equal(batch.appearedAt, 0);
    assert.equal(batch.step, 1, batch.batchId);
    assert.equal(batch.waitedMinutes, 0, batch.batchId);
  }
});

test('пролёживание считается от готовности и только у ожидающих', async () => {
  const trace = await reference;
  const at = 2000;
  for (const batch of batchesAt(trace, at)) {
    if (batch.status === 'running' || batch.status === 'done') {
      assert.equal(batch.waitedMinutes, 0, `у работающей ${batch.batchId} ожидания нет`);
    }
    if (batch.status === 'ready') {
      assert.ok(batch.waitedMinutes >= 0);
    }
  }
});

test('закрытая операция сдвигает партию на следующий шаг', async () => {
  const trace = await reference;
  // На минуте 600 batch-1 закрыл вторую операцию, а готовности третьей ещё нет:
  // партия уже не на фрезерной, но и не начала термообработку — она ждёт.
  const early = batchesAt(trace, 600).find((batch) => batch.batchId === 'batch-1');
  assert.ok(early !== undefined);
  assert.equal(early.step, 3, 'после закрытия шаг 3, а не 2');
  assert.equal(early.areaId, 'area-heat', 'партия на следующем участке');
  assert.equal(early.status, 'ready', 'закрыта операция, не партия: она ждёт');
  assert.ok(early.waitedMinutes >= 0);
});

test('закрытая последняя операция доводит партию до склада', async () => {
  const trace = await reference;
  const late = batchesAt(trace, 8640).find((batch) => batch.batchId === 'batch-1');
  assert.ok(late !== undefined);
  assert.equal(late.step, 7, 'склад — седьмой шаг');
  assert.equal(late.areaId, 'area-fg');
  assert.equal(late.status, 'done', 'на складе партия закрыта');
});

test('участки считают очередь, работу и закрытые', async () => {
  const trace = await reference;
  const areas = areasAt(trace, 720);
  assert.equal(areas.length, 7);
  const total = areas.reduce((sum, area) => sum + area.waiting + area.running + area.done, 0);
  const batches = batchesAt(trace, 720);
  assert.equal(total, batches.length, 'каждая партия стоит ровно на одном участке');
});

test('партия не появляется в цехе раньше приёма заказа', async () => {
  const trace = await accepted;
  const before = batchesAt(trace, 2879).map((batch) => batch.batchId);
  assert.equal(before.includes('batch-7'), false, 'до приёма партии нет');
  const after = batchesAt(trace, 2880).map((batch) => batch.batchId);
  assert.equal(after.includes('batch-7'), true, 'в минуту приёма партия есть');
  const b7 = batchesAt(trace, 2880).find((batch) => batch.batchId === 'batch-7');
  assert.equal(b7?.appearedAt, 2880);
});

test('состояние игры не выходит за границы прогона', async () => {
  const trace = await reference;
  assert.equal(gameAt(trace, -500).minute, 0);
  assert.equal(gameAt(trace, 999999).minute, 8640);
  assert.equal(gameAt(trace, 999999).shift, 11);
});

test('счётчик событий растёт по минуте', async () => {
  const trace = await reference;
  const early = gameAt(trace, 0).eventsSeen;
  const late = gameAt(trace, 8640).eventsSeen;
  assert.ok(late > early);
  assert.equal(late, trace.events.length, 'к концу пройдены все события');
});

test('следующее событие ищется после выбранной минуты', async () => {
  const trace = await reference;
  const first = nextEventMinute(trace, 0);
  assert.ok(first !== null && first > 0);
  assert.equal(nextEventMinute(trace, 8640), null, 'после конца событий нет');
});

test('показатели кадра читаются с покрытием каждого', async () => {
  const trace = await reference;
  const frame = frameAt(trace, 2880);
  assert.ok(frame !== null);
  const rows = frameReadings(frame);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.id), ['portfolio', 'overload', 'acceptedShift', 'scheduleRisk']);
  for (const row of rows) {
    assert.ok(row.coverage >= 0 && row.coverage <= 1, row.id);
    assert.ok(row.text.length > 0, row.id);
  }
  const portfolio = rows.find((row) => row.id === 'portfolio');
  assert.equal(portfolio?.coverage, 0.8, 'на смене 4 неразобранный заказ снижает покрытие');
});

test('игра не запрашивает срез цеха: только след', async () => {
  // Проверка границы: экран игры в списке файлов UI, а собственного транспорта у него нет.
  const { scanUi } = await import('../check-ui.ts');
  const violations = scanUi();
  assert.deepEqual(violations, [], 'граница UI чистая');
});
