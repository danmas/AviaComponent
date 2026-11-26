import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { markByDiscipline } from '../contract/discipline.ts';
import { readContractEvent } from '../contract/events.ts';
import { recordingLagMinutes, instant } from '../contract/time.ts';
import { EVENT_SPEC, ROLES } from '../contract/v1/events.ts';
import { quantity } from '../contract/units.ts';
import { approveShift, appendVersion, recalculate } from '../system/plan.ts';
import { recordDecision, review, type DecisionRecord } from '../system/journal.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('девять ролей, и чужая роль событие не пишет', () => {
  const authors = new Set(Object.values(EVENT_SPEC).map((spec) => spec.author));
  assert.deepEqual([...authors].sort(), [...ROLES].sort());
  assert.throws(() => readContractEvent({
    version: 1,
    type: 'master-close',
    author: 'worker',
    flow: 'into-system',
    operationId: 'op',
    piecesDone: 1,
    piecesScrap: 0,
    trueTime: 1,
    recordTime: 1,
  }));
});

test('отметка мастера и отметка рабочего различимы, пропуска в событии нет', () => {
  const master = readContractEvent({
    version: 1,
    type: 'master-close',
    author: 'master',
    flow: 'into-system',
    operationId: 'op',
    piecesDone: 2,
    piecesScrap: 1,
    trueTime: 10,
    recordTime: 80,
  });
  const worker = readContractEvent({
    version: 1,
    type: 'worker-close',
    author: 'worker',
    flow: 'into-system',
    operationId: 'op',
    piecesDone: 2,
    piecesScrap: 0,
    trueTime: 10,
    recordTime: 10,
  });
  assert.equal(master.type, 'master-close');
  assert.equal(worker.type, 'worker-close');
  assert.notEqual(master.type, worker.type);
  assert.throws(() => readContractEvent({
    version: 1,
    type: 'material-arrived',
    author: 'storekeeper',
    flow: 'into-system',
    orderId: 'o',
    trueTime: 1,
    recordTime: 1,
    missed: true,
  }));
});

test('запаздывание отметки измеримо, бумага и пропуск не создают событие', () => {
  const late = markByDiscipline({
    operationId: 'op',
    trueTime: instant(100),
    piecesDone: 1,
    piecesScrap: 0,
    discipline: 'next-shift',
  });
  assert.ok(late.systemEvent);
  assert.equal(recordingLagMinutes(instant(late.systemEvent.trueTime), instant(late.systemEvent.recordTime)), 720 - 100);
  assert.equal(late.systemEvent.trueTime === late.systemEvent.recordTime, false);

  const paper = markByDiscipline({
    operationId: 'op',
    trueTime: instant(100),
    piecesDone: 1,
    piecesScrap: 0,
    discipline: 'paper',
  });
  assert.equal(paper.systemEvent, null);
  assert.equal(paper.plantNote, 'paper');
  assert.equal(JSON.stringify(paper).includes('missed'), false);

  const skip = markByDiscipline({
    operationId: 'op',
    trueTime: instant(100),
    piecesDone: 1,
    piecesScrap: 0,
    discipline: 'skip',
  });
  assert.equal(skip.systemEvent, null);
  assert.equal(skip.plantNote, 'skip');
});

test('событие версии 1 читается после появления версии 2', () => {
  const v1Source = fs.readFileSync(path.join(root, 'contract', 'v1', 'events.ts'), 'utf8');
  assert.equal(v1Source.includes('note'), false);
  const v1 = readContractEvent({
    version: 1,
    type: 'material-arrived',
    author: 'storekeeper',
    flow: 'into-system',
    orderId: 'o1',
    trueTime: 10,
    recordTime: 20,
  });
  assert.equal(v1.version, 1);
  assert.equal('note' in v1, false);
  const v2 = readContractEvent({
    version: 2,
    type: 'material-arrived',
    author: 'storekeeper',
    flow: 'into-system',
    orderId: 'o1',
    trueTime: 10,
    recordTime: 20,
    note: 'добавлено во второй схеме',
  });
  assert.equal(v2.version, 2);
  if (v2.version !== 2) {
    throw new Error('ожидалась версия 2');
  }
  assert.equal(v2.note, 'добавлено во второй схеме');
  assert.equal(v2.orderId, 'o1');
});

test('пересчёт не затирает версию плана и не меняет снимок смены', () => {
  const due = { orderId: 'o', calculatedDue: instant(1000) };
  const history = appendVersion([], {
    id: 'v1',
    createdAt: instant(0),
    reason: 'первый расчёт',
    orderDue: [due],
  });
  due.calculatedDue = instant(5);
  const first = history[0];
  assert.ok(first);
  assert.equal(first.orderDue[0]?.calculatedDue, 1000);
  const snapshot = approveShift(first, {
    id: 's1',
    shiftIndex: 0,
    approvedAt: instant(0),
    sourceVersionId: 'v1',
    lines: [{ operationId: 'op', norm: quantity('norm-hour', 3) }],
  });
  const next = recalculate(history, snapshot, {
    id: 'v2',
    createdAt: instant(60),
    reason: 'пересчёт',
    orderDue: [{ orderId: 'o', calculatedDue: instant(2000) }],
  });
  assert.equal(next.history.length, 2);
  assert.equal(next.history[0]?.orderDue[0]?.calculatedDue, 1000);
  assert.equal(next.history[1]?.orderDue[0]?.calculatedDue, 2000);
  assert.equal(next.snapshot, snapshot);
  assert.equal(next.snapshot.lines[0]?.norm.amount, 3);
  assert.throws(() => {
    (next.history[0] as { reason: string }).reason = 'подмена';
  });
});

test('журнал фиксирует основание и не содержит оценки', () => {
  type NoScore = 'score' extends keyof DecisionRecord ? never : true;
  const noScore: NoScore = true;
  assert.equal(noScore, true);
  const decision = recordDecision({
    at: instant(15),
    action: 'обещать срок заказчику',
    basisMetric: 'scheduleRisk',
    basisValue: 'overdue=1',
    coverage: 0.28,
    consequence: 'срок обещан при дыре в датах',
  });
  const protocol = review([{ decision, verdict: 'diverged' }]);
  assert.equal(protocol[0]?.verdict, 'diverged');
  assert.equal(JSON.stringify(protocol).includes('score'), false);
});

test('журнал отказывает при пустом действии и покрытии вне доли', () => {
  const base = {
    at: instant(15),
    action: 'приоритет партии batch-3: ранг 0',
    basisMetric: 'scheduleRisk' as const,
    basisValue: 'overdue=1',
    coverage: 0.5,
    consequence: 'ранг действует с начала смены',
  };
  assert.throws(() => recordDecision({ ...base, action: '   ' }), /пустое действие/);
  assert.throws(() => recordDecision({ ...base, coverage: 1.5 }), /доля от 0 до 1/);
  assert.throws(() => recordDecision({ ...base, coverage: -0.1 }), /доля от 0 до 1/);
  assert.throws(() => recordDecision({ ...base, coverage: Number.NaN }), /доля от 0 до 1/);
  const ok = recordDecision(base);
  assert.equal(Object.isFrozen(ok), true);
});
