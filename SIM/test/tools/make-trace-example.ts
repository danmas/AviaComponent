/**
 * Генератор примера следа для docs/TRACE-EXAMPLE.json.
 *
 * Строится из настоящего прогона, а не пишется руками: ключи метрик, форма
 * value и моменты берутся из среза, поэтому пример не может разойтись с моделью.
 *
 * Лежит в `test/tools/`, а не в `scripts/`: граница мира запрещает модулям
 * «other» импортировать сервер, а тестам — разрешает. Генератор поднимает
 * сервер, значит он тестовый инструмент.
 *
 * Запуск: node --experimental-strip-types test/tools/make-trace-example.ts
 */
import fs from 'node:fs';
import { buildApp } from '../../api/server.ts';

const HORIZON = 12;
const OUT = '../docs/TRACE-EXAMPLE.json';

const app = await buildApp();
const created = await app.inject({
  method: 'POST',
  url: '/v1/sessions',
  payload: { seed: 42, level: 'clean', overlay: 'incoming' },
});
const id = (created.json() as { id: string }).id;

// Четыре смены идём без решений: заказ order-5 приходит на границе смены 4.
for (let i = 0; i < 4; i += 1) {
  await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
}

// На смене 4 руководитель принимает заказ: партия batch-7 появляется в цехе.
const accepted = await app.inject({
  method: 'POST',
  url: `/v1/sessions/${id}/decisions`,
  payload: { type: 'accept-order', orderId: 'order-5' },
});
if (accepted.statusCode !== 200) {
  throw new Error(`приём заказа не прошёл: ${accepted.statusCode} ${accepted.body}`);
}
const acceptAt = (accepted.json() as any).decision.appliedAt;

// Сразу после приёма — решение о приоритете: ранг ставит партию вперёд ожидающих.
const ranked = await app.inject({
  method: 'POST',
  url: `/v1/sessions/${id}/decisions`,
  payload: { type: 'priority', batchId: 'batch-7', rank: 0 },
});
if (ranked.statusCode !== 200) {
  throw new Error(`приоритет не прошёл: ${ranked.statusCode} ${ranked.body}`);
}
const rankAt = (ranked.json() as any).decision.appliedAt;

// Доходим до конца горизонта: кадры берём уже с принятым заказом.
for (let i = 4; i < HORIZON; i += 1) {
  await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
}

const shiftMinutes = 720;

/** Кадр на границу смены: показатели с покрытием и положение партий. */
async function frame(shift: number) {
  const summary = (await app.inject({ method: 'GET', url: `/v1/sessions/${id}?shift=${shift}` })).json() as any;
  const shop = (await app.inject({ method: 'GET', url: `/v1/sessions/${id}/shop?shift=${shift}` })).json() as any;
  const metrics = summary.summary.metrics;

  const batches = shop.reality.batches
    .filter((b: any) => b.appearedAt <= shift * shiftMinutes)
    .map((b: any) => {
      const ops = shop.reality.operations.filter((o: any) => o.batchId === b.id);
      const current = ops.find((o: any) => o.status === 'running')
        ?? ops.find((o: any) => o.status === 'ready')
        ?? ops.find((o: any) => o.status === 'not-ready')
        ?? null;
      const lastDone = ops.filter((o: any) => o.status === 'done').pop() ?? null;
      // Сколько пролежала к этой минуте: от готовности текущей операции.
      // Не «сколько ещё», а сколько уже прошло.
      const waitedMinutes = current?.readyAt != null && current.readyAt <= shift * shiftMinutes
        ? shift * shiftMinutes - current.readyAt
        : 0;
      return {
        batchId: b.id,
        areaId: current?.areaId ?? lastDone?.areaId ?? null,
        status: current?.status ?? 'done',
        waitedMinutes,
      };
    });

  return {
    shift,
    at: shift * shiftMinutes,
    metrics: {
      portfolio: { value: metrics.portfolio.value, coverage: metrics.portfolio.coverage },
      overload: {
        value: {
          overloadedCount: metrics.overload.value.overloadedCount,
          queueByUnit: metrics.overload.value.queueByUnit,
        },
        coverage: metrics.overload.coverage,
      },
      acceptedShift: { value: metrics.acceptedShift.value, coverage: metrics.acceptedShift.coverage },
      scheduleRisk: { value: metrics.scheduleRisk.value, coverage: metrics.scheduleRisk.coverage },
    },
    batches,
  };
}

/**
 * Кадр на границу смены.
 *
 * На смене 4 кадр уже содержит `batch-7`: заказ принят в ту же минуту 2880,
 * в которую он пришёл. Если бы решение отложили, партии в кадре не было бы.
 */
const frames: any[] = [];
for (let shift = 0; shift < HORIZON; shift += 1) {
  frames.push(await frame(shift));
}

// События: хрестоматийный путь batch-1 от появления до фрезерной, затем приход
// нового заказа на смене 4, его разбор и решение о приоритете. Полный след даёт
// реализация — здесь показан каждый из шести типов хотя бы один раз.
const events: any[] = [
  { at: 0, type: 'order-registered', orderId: 'order-1', contractDue: 6480 },
  { at: 0, type: 'batch-appeared', batchId: 'batch-1', orderId: 'order-1', appearedAt: 0, qty: 4 },
  { at: 0, type: 'operation-ready', operationId: 'batch-1-op-0', batchId: 'batch-1', areaId: 'area-cnc-turn', readyAt: 0 },
  { at: 40, type: 'operation-started', operationId: 'batch-1-op-0', batchId: 'batch-1', areaId: 'area-cnc-turn', startedAt: 40 },
  { at: 180, type: 'operation-completed', operationId: 'batch-1-op-0', batchId: 'batch-1', done: 4, good: 4 },
  { at: 180, type: 'operation-ready', operationId: 'batch-1-op-1', batchId: 'batch-1', areaId: 'area-mill', readyAt: 180 },

  // Смена 4: пришёл пятый заказ. Срок — смена 6, то есть 4320 минут.
  // Он не разобран, поэтому партии нет: batch-7 появится только после приёма.
  { at: 2880, type: 'order-registered', orderId: 'order-5', contractDue: 4320 },

  // Руководитель принял заказ: партия появилась в цехе в ту же минуту.
  { at: acceptAt, type: 'batch-appeared', batchId: 'batch-7', orderId: 'order-5', appearedAt: acceptAt, qty: 4 },
  { at: acceptAt, type: 'decision-applied', decisionType: 'accept-order', batchId: 'batch-7', appliedAt: acceptAt, rank: null },

  // Затем решение о приоритете: ранг 0 ставит партию вперёд ожидающих.
  { at: rankAt, type: 'decision-applied', decisionType: 'priority', batchId: 'batch-7', appliedAt: rankAt, rank: 0 },
  { at: rankAt, type: 'operation-ready', operationId: 'batch-7-op-0', batchId: 'batch-7', areaId: 'area-cnc-turn', readyAt: rankAt },
];

const trace = {
  meta: {
    seed: 42,
    level: 'clean',
    overlay: 'incoming',
    horizonShifts: HORIZON,
    shiftMinutes,
    note: 'Числа модельные. Структура и ключи — реальные, из срезов прогона.',
  },
  events,
  frames,
};

fs.writeFileSync(OUT, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
console.log(`записано ${OUT}: событий ${events.length}, кадров ${frames.length}`);

await app.close();
