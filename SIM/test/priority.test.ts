import assert from 'node:assert/strict';
import test from 'node:test';

import { SHIFT_MINUTES } from '../contract/time.ts';
import { runStand } from '../run/run.ts';

const SEED = 42;
const DECISION_AT = 4 * SHIFT_MINUTES;

function cleanRun(priority?: readonly { batchId: string; rank: number; appliedAt: number }[]) {
  return priority === undefined
    ? runStand({ seed: SEED, level: 'clean', overlay: 'none' })
    : runStand({ seed: SEED, level: 'clean', overlay: 'none', priority });
}

const key = (c: { operationId: string; at: number }): string => `${c.at}|${c.operationId}`;

function before(completions: readonly { operationId: string; at: number }[], minute: number): string[] {
  return completions.filter((c) => c.at < minute).map(key).sort();
}

/** Длительность каждой операции: от старта до закрытия. */
function durations(result: ReturnType<typeof cleanRun>): Map<string, number> {
  const map = new Map<string, number>();
  for (const start of result.starts) {
    const done = result.report.shopCompletions.find((c) => c.operationId === start.operationId);
    if (done) {
      map.set(start.operationId, done.at - start.at);
    }
  }
  return map;
}

test('пустой список решений даёт прежний отчёт побайтово', () => {
  assert.equal(cleanRun([]).reportJson, cleanRun().reportJson);
});

test('решение не переписывает прошлое', () => {
  const base = cleanRun();
  for (const batchId of ['batch-3', 'batch-5', 'batch-6']) {
    const pushed = cleanRun([{ batchId, rank: 0, appliedAt: DECISION_AT }]);
    assert.deepEqual(
      before(pushed.report.shopCompletions, DECISION_AT),
      before(base.report.shopCompletions, DECISION_AT),
      `решение по ${batchId} изменило закрытия до момента решения`,
    );
  }
});

test('решение меняет будущее: batch-5 обгоняет batch-2 на слесарной', () => {
  // К минуте решения batch-2 и batch-5 уже сидят в одной садке.
  // Ранг садку не разнимает. Слесарная — один человек, и здесь порядок меняется.
  const base = cleanRun();
  const pushed = cleanRun([{ batchId: 'batch-5', rank: 0, appliedAt: DECISION_AT }]);
  const atOf = (result: ReturnType<typeof cleanRun>, operationId: string) =>
    result.report.shopCompletions.find((completion) => completion.operationId === operationId)?.at;
  assert.equal(atOf(base, 'batch-2-op-2'), atOf(base, 'batch-5-op-2'), 'в базе партии сидят в одной садке');
  assert.equal(atOf(pushed, 'batch-2-op-2'), atOf(base, 'batch-2-op-2'), 'ранг сдвинул уже посаженную садку');
  assert.equal(atOf(pushed, 'batch-5-op-2'), atOf(base, 'batch-5-op-2'), 'ранг сдвинул уже посаженную садку');
  const baseBench2 = atOf(base, 'batch-2-op-3');
  const baseBench5 = atOf(base, 'batch-5-op-3');
  const pushedBench2 = atOf(pushed, 'batch-2-op-3');
  const pushedBench5 = atOf(pushed, 'batch-5-op-3');
  assert.ok(baseBench2 !== undefined && baseBench5 !== undefined && baseBench2 < baseBench5, 'в базе слесарную первой берёт batch-2');
  assert.ok(
    pushedBench2 !== undefined && pushedBench5 !== undefined && pushedBench5 < pushedBench2,
    'после решения слесарную первой берёт batch-5',
  );
});

test('решение не ускоряет ресурс', () => {
  const base = durations(cleanRun());
  const pushed = durations(cleanRun([{ batchId: 'batch-3', rank: 0, appliedAt: DECISION_AT }]));
  let changed = 0;
  for (const [operationId, minutes] of base) {
    const after = pushed.get(operationId);
    if (after !== undefined && after !== minutes) {
      changed += 1;
    }
  }
  assert.equal(changed, 0, 'решение изменило длительность хотя бы одной операции');
});

test('ранг действует только с момента применения', () => {
  const base = cleanRun();
  const atStart = key({ operationId: 'batch-3-op-0', at: 1440 });
  const late = cleanRun([{ batchId: 'batch-3', rank: 0, appliedAt: DECISION_AT }]);
  const early = cleanRun([{ batchId: 'batch-3', rank: 0, appliedAt: 0 }]);
  assert.ok(base.report.shopCompletions.map(key).includes(atStart), 'база не содержит ожидаемого закрытия');
  assert.ok(late.report.shopCompletions.map(key).includes(atStart), 'решение на 5-й смене сдвинуло ранее закрытие');
  assert.notDeepEqual(
    late.report.shopCompletions.map(key),
    early.report.shopCompletions.map(key),
    'решение с нулевой минуты и с пятой смены дали одинаковый прогон',
  );
});

test('прогон с решениями детерминирован', () => {
  const decision = [{ batchId: 'batch-3', rank: 0, appliedAt: DECISION_AT }];
  assert.equal(cleanRun(decision).reportJson, cleanRun(decision).reportJson);
});

test('повторный ранг перекрывает прежний с этого момента', () => {
  const at = 4 * SHIFT_MINUTES;
  const competitor = { batchId: 'batch-2', rank: 5, appliedAt: at };
  const best = { batchId: 'batch-5', rank: 0, appliedAt: at };
  const worse = { batchId: 'batch-5', rank: 9, appliedAt: at };
  const onlyBest = cleanRun([competitor, best]);
  const onlyWorse = cleanRun([competitor, worse]);
  const shadowed = cleanRun([competitor, best, worse]);
  assert.notEqual(onlyBest.reportJson, onlyWorse.reportJson);
  assert.equal(shadowed.reportJson, onlyWorse.reportJson);
  assert.deepEqual(before(shadowed.report.shopCompletions, at), before(onlyBest.report.shopCompletions, at));
});

test('ранг не подменяет договорную дату', () => {
  const base = cleanRun();
  const pushed = cleanRun([{ batchId: 'batch-3', rank: 0, appliedAt: DECISION_AT }]);
  assert.deepEqual(
    pushed.records.orders.map((o) => [o.id, o.contractDue]),
    base.records.orders.map((o) => [o.id, o.contractDue]),
  );
});

test('срез на границу смены считается прогоном N+1, а не берётся из горизонта', () => {
  const full = cleanRun();
  const loadsOf = (result: ReturnType<typeof cleanRun>) =>
    JSON.stringify(result.records.areaLoads.map((a) => [a.areaId, a.plan.amount, a.queue.amount]));
  for (const shift of [0, 5]) {
    const slice = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: shift + 1 });
    assert.notEqual(loadsOf(slice), loadsOf(full), `срез смены ${shift} совпал с полным горизонтом`);
    assert.deepEqual(
      slice.records.areaLoads.map((a) => a.areaId),
      full.records.areaLoads.map((a) => a.areaId),
      'срез потерял участки загрузки',
    );
  }
  const last = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: 12 });
  assert.equal(loadsOf(last), loadsOf(full), 'срез последней смены обязан совпасть с горизонтом');
});

test('префикс устойчив на границах 0, 5 и 11', () => {
  const full = cleanRun();
  for (const shift of [0, 5, 11]) {
    const slice = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: shift + 1 });
    const boundary = (shift + 1) * SHIFT_MINUTES;
    const key = (c: { at: number; operationId: string }) => `${c.at}|${c.operationId}`;
    const closesBefore = (result: ReturnType<typeof cleanRun>) =>
      result.report.shopCompletions.filter((c) => c.at < boundary).map(key).sort();
    assert.deepEqual(closesBefore(slice), closesBefore(full), `закрытия до границы ${boundary} разошлись`);
    assert.deepEqual(slice.report.shifts, full.report.shifts.slice(0, shift + 1), `смены до ${shift} разошлись`);
  }
});
