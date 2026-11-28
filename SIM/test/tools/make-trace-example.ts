/**
 * Генератор примера следа для docs/TRACE-EXAMPLE.json.
 *
 * Берёт готовый ответ `GET /v1/sessions/:id/trace` и оставляет из событий
 * показательный набор, покрывающий все шесть типов. Всё остальное — `apiVersion`,
 * `meta`, все 12 кадров — копируется из ответа как есть, поэтому пример не может
 * разойтись с реализацией ни формой, ни полями.
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
const ACCEPT_SHIFT = 4;
const OUT = '../docs/TRACE-EXAMPLE.json';

const app = await buildApp();
const created = await app.inject({
  method: 'POST',
  url: '/v1/sessions',
  payload: { seed: 42, level: 'clean', overlay: 'incoming' },
});
const id = (created.json() as { id: string }).id;

// Четыре смены без решений: заказ order-5 приходит на границе смены 4.
for (let i = 0; i < ACCEPT_SHIFT; i += 1) {
  await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
}

// Приём заказа: партия batch-7 появляется в цехе.
const accepted = await app.inject({
  method: 'POST',
  url: `/v1/sessions/${id}/decisions`,
  payload: { type: 'accept-order', orderId: 'order-5' },
});
if (accepted.statusCode !== 200) {
  throw new Error(`приём заказа не прошёл: ${accepted.statusCode} ${accepted.body}`);
}

// Приоритет: ранг ставит партию вперёд ожидающих.
const ranked = await app.inject({
  method: 'POST',
  url: `/v1/sessions/${id}/decisions`,
  payload: { type: 'priority', batchId: 'batch-7', rank: 0 },
});
if (ranked.statusCode !== 200) {
  throw new Error(`приоритет не прошёл: ${ranked.statusCode} ${ranked.body}`);
}

// Доходим до конца горизонта: кадры берём уже с принятым заказом.
for (let i = ACCEPT_SHIFT; i < HORIZON; i += 1) {
  await app.inject({ method: 'POST', url: `/v1/sessions/${id}/advance` });
}

const response = await app.inject({ method: 'GET', url: `/v1/sessions/${id}/trace` });
if (response.statusCode !== 200) {
  throw new Error(`след не отдался: ${response.statusCode} ${response.body}`);
}
const full = response.json() as any;

/**
 * Показательный набор событий. Полный след — 155 событий; для примера формы
 * достаточно одного прохода партии по двум первым участкам и прихода нового
 * заказа с двумя решениями. Все шесть типов обязаны присутствовать.
 */
const SERIAL_SHOWN = new Set(['batch-1-op-0', 'batch-1-op-1']);
const keep = (event: any): boolean => {
  if (event.type === 'order-registered') {
    return event.orderId === 'order-1' || event.orderId === 'order-5';
  }
  if (event.type === 'batch-appeared') {
    return event.batchId === 'batch-1' || event.batchId === 'batch-7';
  }
  if (event.type === 'decision-applied') {
    return true;
  }
  // Шаги batch-1 и первая операция новой партии.
  return SERIAL_SHOWN.has(event.operationId) || event.operationId === 'batch-7-op-0';
};

const events = full.events.filter(keep);

const trace = {
  apiVersion: full.apiVersion,
  // `meta` копируется из ответа целиком, включая `note`: пример обязан
  // совпадать с реализацией и в шапке, а не только в событиях и кадрах.
  meta: full.meta,
  events,
  frames: full.frames,
};

fs.writeFileSync(OUT, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');

const types = [...new Set(events.map((e: any) => e.type))].sort();
console.log(`записано ${OUT}: событий ${events.length} из ${full.events.length}, кадров ${trace.frames.length}`);
console.log('типы событий:', types.join(', '));

await app.close();
