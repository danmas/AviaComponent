import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTRACT_STAND } from '../contract/stand.ts';
import { pieces, summedPieces } from '../contract/quantity.ts';
import { instant, nextShiftStart, shiftWindow } from '../contract/time.ts';
import { quantity } from '../contract/units.ts';
import { tearOffBatch } from '../plant/batch.ts';
import { MACHINE_MTBF_BUSY_MINUTES } from '../plant/engine.ts';
import { occupationMinutes } from '../plant/occupation.ts';
import { PLANT_STAND, ROUTE } from '../plant/stand.ts';
import { disciplineDecision, EXPECTED, LEVEL_RULES } from '../run/levels.ts';
import { runStand } from '../run/run.ts';
import { acceptedShift, fourMetrics, systemSeesOperation } from '../system/metrics.ts';

const SEED = 20261126;

function body(json: string): string {
  const value = JSON.parse(json) as { seed?: number };
  delete value.seed;
  return JSON.stringify(value);
}

function processingDone(jsonShop: { readonly shopCompletions: readonly { readonly warehouse: boolean }[] }): number {
  return jsonShop.shopCompletions.filter((completion) => !completion.warehouse).length;
}

test('нормо-час не переводится в минуты занятия', () => {
  assert.equal(occupationMinutes(quantity('machine-hour', 4)), 240);
  assert.equal(occupationMinutes(quantity('charge-day', 1)), 1440);
  assert.throws(() => occupationMinutes(quantity('norm-hour', 1)), /нормо-час|нет основания/);
});

test('доли уровней зафиксированы до прогона', () => {
  assert.equal(LEVEL_RULES.clean.outsideShare, 0.05);
  assert.equal(LEVEL_RULES.paper.outsideShare, 0.35);
  assert.equal(LEVEL_RULES.late.outsideShare, 0);
  assert.equal(disciplineDecision(LEVEL_RULES.paper, 0.1).miss, 'paper');
  assert.equal(disciplineDecision(LEVEL_RULES.paper, 0.9).miss, null);
  assert.equal(disciplineDecision(LEVEL_RULES.clean, 0.04).miss, 'skip');
  assert.equal(disciplineDecision(LEVEL_RULES.late, null).discipline, 'next-shift');
  assert.equal(EXPECTED.marks, 36);
});

test('один seed даёт один отчёт, другой seed — другой', () => {
  const first = runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  const second = runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  assert.equal(first.reportJson, second.reportJson);
  const other = runStand({ seed: SEED + 1, level: 'clean', overlay: 'none' });
  assert.notEqual(body(first.reportJson), body(other.reportJson));
});

test('чистые, поздние и бумага оставляют один и тот же цех', () => {
  const clean = runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  const late = runStand({ seed: SEED, level: 'late', overlay: 'none' });
  const paper = runStand({ seed: SEED, level: 'paper', overlay: 'none' });
  assert.equal(JSON.stringify(clean.report.shopCompletions), JSON.stringify(late.report.shopCompletions));
  assert.equal(JSON.stringify(clean.report.shopCompletions), JSON.stringify(paper.report.shopCompletions));
  assert.ok(late.report.facts.length > 0);
  for (const fact of late.report.facts) {
    assert.equal(fact.recordTime, nextShiftStart(instant(fact.trueTime)));
    assert.ok(fact.recordTime !== fact.trueTime);
  }
  for (const fact of clean.report.facts) {
    assert.equal(fact.recordTime, fact.trueTime);
  }
  for (const note of clean.report.notes) {
    assert.equal(note.note, 'skip');
    assert.equal(systemSeesOperation(clean.records, note.operationId), false);
  }
  for (const note of paper.report.notes) {
    assert.equal(note.note, 'paper');
    assert.equal(systemSeesOperation(paper.records, note.operationId), false);
  }
  // Факт пишется на закрытую операцию, а не на каждую порцию.
  const lateOperations = new Set(
    late.report.shopCompletions
      .filter((completion) => !completion.warehouse)
      .map((completion) => completion.operationId),
  );
  assert.equal(late.report.facts.length, lateOperations.size);
});

test('пустые поля не получают срок и не стартуют без материала', () => {
  const empty = runStand({ seed: SEED, level: 'empty', overlay: 'none' });
  const blocked = empty.shop.operations.find((operation) => operation.id === 'batch-5-op-0');
  assert.ok(blocked);
  assert.equal(blocked.status, 'not-ready');
  assert.ok(blocked.missing.includes('material'));
  assert.equal(empty.records.orders.find((order) => order.id === 'order-3')?.contractDue, null);
  assert.equal(empty.records.norms.some((norm) => norm.orderId === 'order-3'), false);
  for (const version of empty.versions) {
    assert.equal(version.orderDue.find((row) => row.orderId === 'order-3')?.calculatedDue, null);
    assert.equal(version.orderDue.find((row) => row.orderId === 'order-4')?.calculatedDue, null);
  }
  assert.equal(empty.snapshots.length, 12);
  assert.equal(Object.isFrozen(empty.snapshots[0]), true);
  assert.notEqual(empty.snapshots[0]?.sourceVersionId, empty.snapshots[11]?.sourceVersionId);
});

test('помехи не двигают долю дисциплины и MTBF', () => {
  const plain = runStand({ seed: 1, level: 'clean', overlay: 'none' });
  const urgent = runStand({ seed: 1, level: 'clean', overlay: 'urgent' });
  const broken = runStand({ seed: 1, level: 'clean', overlay: 'breakdown' });
  const scrap = runStand({ seed: 1, level: 'late', overlay: 'scrap' });
  assert.equal(plain.report.firstStarts.find((start) => start.resourceId === 'area-cnc-turn-1')?.operationId, 'batch-4-op-0');
  assert.equal(urgent.report.firstStarts.find((start) => start.resourceId === 'area-cnc-turn-1')?.operationId, 'batch-5-op-0');
  assert.equal(urgent.report.parameters.outsideShare, plain.report.parameters.outsideShare);
  assert.ok(broken.starts.filter((start) => start.resourceId === 'area-cnc-turn-1').every((start) => start.at >= 720));
  assert.equal(broken.report.parameters.mtbfBusyMinutes, MACHINE_MTBF_BUSY_MINUTES);
  assert.equal(broken.report.parameters.mtbfBusyMinutes, plain.report.parameters.mtbfBusyMinutes);
  assert.ok(broken.report.downtimes.some((downtime) => downtime.id === 'scripted-breakdown'));
  const turn = scrap.shop.operations.find((operation) => operation.id === 'batch-1-op-0');
  assert.equal(turn?.scrap, 0, 'токарная брак не задаёт');
  assert.equal(scrap.shop.operations.find((operation) => operation.id === 'batch-1-op-1')?.planned, 4);
  const found = scrap.shop.operations.filter(
    (operation) => (operation.areaId === 'area-test' || operation.areaId === 'area-final') && operation.scrap > 0,
  );
  assert.ok(found.length > 0, 'брак возникает на контроле');
  for (const operation of found) {
    const child = scrap.shop.batches.find((batch) => batch.id === `${operation.batchId}-defect-${operation.sequence}`);
    assert.ok(child, `нет отрыва по ведомости у ${operation.id}`);
    assert.equal(child?.qty, operation.scrap);
    assert.equal(child?.countsApart, false);
    assert.equal(child?.tearOff, 'defect-sheet');
    const parent = scrap.shop.batches.find((batch) => batch.id === operation.batchId);
    assert.ok(parent);
    assert.equal(summedPieces([parent, child]), parent?.qty);
  }
});

test('печь держит общую садку, человек остаётся в смене', () => {
  const run = runStand({ seed: SEED, level: 'late', overlay: 'none' });
  const heat = run.starts.filter((start) => start.resourceId === 'area-heat-1').sort((left, right) => left.at - right.at);
  assert.ok(heat.length >= 2);
  const finishAt = new Map<string, number>();
  for (const completion of run.report.shopCompletions) {
    if (!completion.operationId.endsWith('-op-2')) {
      continue;
    }
    const previous = finishAt.get(completion.operationId) ?? 0;
    if (completion.at >= previous) {
      finishAt.set(completion.operationId, completion.at);
    }
  }
  const byEnd = new Map<number, number[]>();
  for (const start of heat) {
    const end = finishAt.get(start.operationId);
    if (end === undefined) {
      continue;
    }
    const group = byEnd.get(end) ?? [];
    group.push(start.at);
    byEnd.set(end, group);
  }
  const ends = [...byEnd.keys()].sort((left, right) => left - right);
  assert.ok(ends.some((end) => (byEnd.get(end) ?? []).length >= 2), 'хотя бы одна садка держит две партии');
  for (const end of ends) {
    const seated = byEnd.get(end) ?? [];
    const first = Math.min(...seated);
    assert.equal(end, first + 1440, 'садка закрывается через сутки после первой посадки');
  }
  for (let index = 1; index < ends.length; index += 1) {
    const previousEnd = ends[index - 1] ?? 0;
    const nextEnd = ends[index] ?? 0;
    const nextSeated = byEnd.get(nextEnd) ?? [];
    assert.ok(Math.min(...nextSeated) >= previousEnd, 'новая садка не начинается, пока предыдущая не закрыта');
  }
  const personnel = new Set(run.shop.resources.filter((resource) => resource.kind === 'personnel').map((resource) => resource.id));
  let personnelStarts = 0;
  for (const start of run.starts) {
    if (!personnel.has(start.resourceId)) {
      continue;
    }
    personnelStarts += 1;
    const operation = run.shop.operations.find((item) => item.id === start.operationId);
    assert.ok(operation);
    const shiftEnd = (Math.floor(start.at / 720) + 1) * 720;
    assert.ok(start.at + occupationMinutes(operation.effort) <= shiftEnd);
  }
  assert.ok(personnelStarts >= 1);
  for (const operation of run.shop.operations) {
    if (operation.status !== 'done') {
      continue;
    }
    const next = run.shop.operations.find((item) => item.batchId === operation.batchId && item.sequence === operation.sequence + 1);
    if (!next) {
      continue;
    }
    assert.equal(next.planned, operation.done - operation.scrap);
  }
  assert.throws(() => tearOffBatch(run.shop, 'batch-1', 'batch-late', pieces(1), 'manual'));
});

test('показатели не читают цех, знаменатель не равен хвосту прогона', () => {
  const run = runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  const level = { orders: EXPECTED.orders, areas: EXPECTED.loadAreas, shiftFacts: EXPECTED.marks };
  const last = shiftWindow(CONTRACT_STAND.horizonShifts - 1, CONTRACT_STAND.horizonShifts);
  const before = JSON.stringify(fourMetrics(run.records, level, last));
  const tweaked = { ...run.shop, now: instant(5), operations: [] };
  void tweaked;
  assert.equal(JSON.stringify(fourMetrics(run.records, level, last)), before);
  const shopDone = processingDone(run.report);
  // Знаменатель — ожидаемые 36 отметок. Число записей закрытия больше:
  // часть операций закрывается двумя порциями.
  assert.ok(shopDone > EXPECTED.marks, 'хвост записей закрытия не совпал со знаменателем');
  let separated = false;
  for (let index = 0; index < CONTRACT_STAND.horizonShifts; index += 1) {
    const window = shiftWindow(index, CONTRACT_STAND.horizonShifts);
    const byLevel = acceptedShift(run.records, window, EXPECTED.marks);
    if (byLevel.value.masterCloses === 0) {
      continue;
    }
    const byRun = acceptedShift(run.records, window, shopDone);
    assert.notEqual(byLevel.coverage, byRun.coverage);
    separated = true;
    break;
  }
  assert.equal(separated, true);
  assert.equal(run.report.expected.marks, EXPECTED.marks);
  assert.equal(run.report.shifts.length, 12);
  assert.ok(run.report.shifts[0]?.shopReady.includes('batch-4-op-0'));
});

test('эталоны четырёх уровней совпадают с первым прогоном', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  for (const level of ['clean', 'late', 'paper', 'empty'] as const) {
    const result = runStand({ seed: SEED, level, overlay: 'none' });
    const stored = fs.readFileSync(path.join(dir, `run-${level}-none-${SEED}.json`), 'utf8');
    assert.equal(result.reportJson, stored);
  }
});

test('ёмкости стенда после прогона те же', () => {
  runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  assert.equal(CONTRACT_STAND.shiftHours, 12);
  assert.equal(CONTRACT_STAND.horizonShifts, 12);
  assert.equal(CONTRACT_STAND.orderCount, 4);
  assert.equal(CONTRACT_STAND.batchCount, 6);
  assert.equal(CONTRACT_STAND.routeLength, 7);
  assert.equal(PLANT_STAND.furnaceChargePieces, 8);
  assert.deepEqual(
    ROUTE.map((step) => (step.effort === null ? null : [step.effort.kind, step.effort.amount])),
    [
      ['machine-hour', 4],
      ['machine-hour', 4],
      ['charge-day', 1],
      ['person-hour', 6],
      ['person-hour', 4],
      ['person-hour', 2],
      null,
    ],
  );
});

test('горизонт приходит аргументом, а не из константы', () => {
  const short = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: 5 });
  const long = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: 12 });
  assert.equal(short.report.shifts.length, 5);
  assert.equal(long.report.shifts.length, 12);
  assert.equal(short.report.parameters.horizonShifts, 5);
  assert.equal(short.report.acceptedByShift.at(-1)?.index, 4);
  assert.equal(CONTRACT_STAND.horizonShifts, 12);
});

test('без аргумента горизонт равен стенду', () => {
  const noArg = runStand({ seed: SEED, level: 'clean', overlay: 'none' });
  const withArg = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: CONTRACT_STAND.horizonShifts });
  assert.equal(noArg.reportJson, withArg.reportJson);
});

test('горизонт вне диапазона стенда отвергается', () => {
  for (const horizonShifts of [0, -1, 2.5, CONTRACT_STAND.horizonShiftsMax + 1]) {
    assert.throws(
      () => runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts }),
      /Горизонт прогона/,
      `горизонт ${horizonShifts} должен быть отвергнут`,
    );
  }
});

test('префикс отчёта не зависит от горизонта', () => {
  const short = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: 5 });
  const long = runStand({ seed: SEED, level: 'clean', overlay: 'none', horizonShifts: 12 });
  assert.deepEqual(short.report.shifts, long.report.shifts.slice(0, 5));
  assert.deepEqual(short.report.acceptedByShift, long.report.acceptedByShift.slice(0, 5));
});
