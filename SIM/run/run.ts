import { markByDiscipline } from '../contract/discipline.ts';
import { parseEventV1 } from '../contract/v1/events.ts';
import { createRng } from '../contract/rng.ts';
import { pieces } from '../contract/quantity.ts';
import { assertStandInSpec, CONTRACT_STAND } from '../contract/stand.ts';
import { inShift, instant, SHIFT_MINUTES, shiftWindow, type SimInstant } from '../contract/time.ts';
import { quantity, type AnyQuantity, type UnitKind } from '../contract/units.ts';
import { launchBatch } from '../plant/batch.ts';
import { MACHINE_MTBF_BUSY_MINUTES, REPAIR_MINUTES, runShop, type PriorityOrder, type ScheduledLaunch, type ShopCompletion, type ShopStart } from '../plant/engine.ts';
import { occupationMinutes } from '../plant/occupation.ts';
import { ROUTE, type RouteStep } from '../plant/stand.ts';
import { addDowntime, createShop, type PlantState } from '../plant/state.ts';
import { orderDecisionRecord, type DecisionRecord } from '../system/journal.ts';
import { appendVersion, approveShift, type PlanVersion, type ShiftSnapshot } from '../system/plan.ts';
import {
  acceptedShift,
  fourMetrics,
  type AcceptedShiftValue,
  type MetricId,
  type MetricResult,
  type OverloadValue,
  type PortfolioValue,
  type ScheduleRiskValue,
} from '../system/metrics.ts';
import type { AreaLoadRecord, FactRecord, NormRecord, OrderRecord, PlanDateRecord, RouteCardOperation, SystemRecords } from '../system/types.ts';
import {
  BATCH_PIECES,
  BREAKDOWN_RESOURCE,
  BREAKDOWN_UNTIL,
  ordersFor,
  type StandOrder,
} from './catalog.ts';
import { disciplineDecision, EXPECTED, LEVEL_RULES, type LevelName, type OverlayName } from './levels.ts';

const ORDER_NORM_HOURS = 6;
const OPERATION_NORM_HOURS = 1;

/** Замер до правил цеха: отчёт clean/none, seed 42, 37 записей. */
const COMPLETION_BASELINE_BYTES = 9300;
const COMPLETION_GROWTH_LIMIT = 3;

interface StepRef {
  readonly sequence: number;
  readonly step: RouteStep;
}

interface QueueRow {
  readonly operationId: string;
  readonly areaId: string;
  readonly effort: AnyQuantity;
  readonly norm: NormRecord['norm'];
}

export interface RunReport {
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly expected: { readonly orders: number; readonly loadAreas: number; readonly marks: number };
  readonly parameters: {
    readonly horizonShifts: number;
    readonly batchPieces: number;
    readonly mtbfBusyMinutes: number;
    readonly repairMinutes: number;
    readonly outsideShare: number;
  };
  readonly contractEventCount: number;
  readonly failureBusyMinute: readonly { readonly resourceId: string; readonly busyMinute: number }[];
  readonly downtimes: readonly {
    readonly id: string;
    readonly resourceId: string;
    readonly from: number;
    readonly until: number | null;
    readonly reason: string;
  }[];
  readonly shopCompletions: readonly {
    readonly operationId: string;
    readonly at: number;
    readonly done: number;
    readonly scrap: number;
    readonly warehouse: boolean;
  }[];
  readonly firstStarts: readonly { readonly resourceId: string; readonly operationId: string; readonly at: number }[];
  readonly notes: readonly { readonly operationId: string; readonly note: 'paper' | 'skip'; readonly at: number }[];
  readonly facts: readonly { readonly operationId: string; readonly trueTime: number; readonly recordTime: number }[];
  readonly shifts: readonly {
    readonly index: number;
    readonly shopReady: readonly string[];
    readonly shopCompleted: readonly string[];
    readonly recordedFacts: readonly string[];
  }[];
  readonly acceptedByShift: readonly { readonly index: number; readonly normHours: number; readonly operationIds: readonly string[] }[];
  readonly warehouseOrders: readonly string[];
  readonly metrics: {
    readonly portfolio: { readonly openCount: number; readonly remainderNormHours: number; readonly ordersWithoutNorm: number; readonly coverage: number };
    readonly overload: { readonly overloadedCount: number; readonly coverage: number };
    readonly acceptedShift: { readonly shiftIndex: number; readonly normHours: number; readonly coverage: number };
    readonly scheduleRisk: { readonly overdue: number; readonly onTime: number; readonly unevaluated: number; readonly coverage: number };
  };
}

/** Решение руководителя по поступившему заказу. В отчёт прогона не входит. */
export interface OrderChoice {
  readonly type: 'accept-order' | 'defer-order';
  readonly orderId: string;
  readonly at: number;
  readonly basisMetric: MetricId;
}

export interface RunResult {
  readonly report: RunReport;
  readonly reportJson: string;
  readonly shop: PlantState;
  readonly records: SystemRecords;
  readonly snapshots: readonly ShiftSnapshot[];
  readonly versions: readonly PlanVersion[];
  readonly starts: readonly ShopStart[];
  readonly decisionJournal: readonly DecisionRecord[];
  readonly contractEvents: readonly unknown[];
  /** Порции закрытия, как их записал цех. В отчёт не входят: отчёт их группирует. */
  readonly completions: readonly ShopCompletion[];
}

function processingSteps(): readonly StepRef[] {
  return ROUTE.map((step, sequence) => ({ step, sequence })).filter((item) => item.step.role.role === 'processing');
}

function amountOf(kind: UnitKind, amount: number): AnyQuantity {
  switch (kind) {
    case 'machine-hour':
      return quantity('machine-hour', amount);
    case 'person-hour':
      return quantity('person-hour', amount);
    case 'charge-day':
      return quantity('charge-day', amount);
    case 'norm-hour':
      return quantity('norm-hour', amount);
    case 'furnace-hour':
      return quantity('furnace-hour', amount);
  }
}

function capacityOf(step: RouteStep): AnyQuantity {
  if (step.effort === null) {
    throw new Error(`У участка «${step.areaId}» нет загрузки.`);
  }
  if (step.effort.kind === 'machine-hour' || step.effort.kind === 'person-hour') {
    return amountOf(step.effort.kind, 12);
  }
  if (step.effort.kind === 'charge-day') {
    return amountOf('charge-day', 0.5);
  }
  throw new Error(`Для единицы «${step.effort.kind}» нет мощности смены.`);
}

function byText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function groupCompletions<T extends {
  readonly operationId: string;
  readonly at: number;
  readonly done: number;
  readonly scrap: number;
  readonly warehouse: boolean;
}>(rows: readonly T[]): T[] {
  const grouped = new Map<string, T>();
  for (const row of rows) {
    const prev = grouped.get(row.operationId);
    if (prev === undefined) {
      grouped.set(row.operationId, { ...row });
      continue;
    }
    grouped.set(row.operationId, {
      ...prev,
      at: Math.max(prev.at, row.at),
      done: prev.done + row.done,
      scrap: prev.scrap + row.scrap,
      warehouse: prev.warehouse || row.warehouse,
    });
  }
  return [...grouped.values()].sort(
    (left, right) => left.at - right.at || byText(left.operationId, right.operationId),
  );
}

function orderStatus(order: StandOrder): OrderRecord['status'] {
  return order.material && order.designDoc && order.norms ? 'in-production' : 'dse';
}

export function runStand(input: {
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  /** Горизонт прогона. По умолчанию — значение стенда. Диапазон 1..horizonShiftsMax. */
  readonly horizonShifts?: number;
  /** Решения о приоритете, действующие с момента appliedAt. */
  readonly priority?: readonly PriorityOrder[];
  /** Принять или отложить заказ. Пусто — решает только признак каталога. */
  readonly orderChoices?: readonly OrderChoice[];
}): RunResult {
  assertStandInSpec();
  const horizon = input.horizonShifts ?? CONTRACT_STAND.horizonShifts;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > CONTRACT_STAND.horizonShiftsMax) {
    throw new Error(`Горизонт прогона — целое число от 1 до ${CONTRACT_STAND.horizonShiftsMax} смен.`);
  }
  const rule = LEVEL_RULES[input.level];
  const catalog = ordersFor(input.level, input.overlay);
  const choices = input.orderChoices ?? [];
  const steps = processingSteps();
  const horizonEnd = horizon * SHIFT_MINUTES;
  let contractEventCount = 0;
  const contractEvents: unknown[] = [];

  function launchMinuteOf(order: StandOrder): number | null {
    if (order.acceptedByDefault) {
      return order.arrivesAt;
    }
    let accepted: number | null = null;
    for (const choice of choices) {
      if (choice.orderId !== order.id || choice.type !== 'accept-order') {
        continue;
      }
      if (accepted === null || choice.at < accepted) {
        accepted = choice.at;
      }
    }
    return accepted;
  }

  function takenBy(order: StandOrder, at: number): boolean {
    const minute = launchMinuteOf(order);
    return minute !== null && minute <= at;
  }

  for (const choice of choices) {
    const order = catalog.find((item) => item.id === choice.orderId);
    if (order === undefined) {
      throw new Error(`Решение по неизвестному заказу «${choice.orderId}».`);
    }
    if (order.acceptedByDefault) {
      throw new Error(`Заказ «${order.id}» уже принят каталогом.`);
    }
    if (choice.at < order.arrivesAt) {
      throw new Error(`Заказ «${order.id}» ещё не поступил к минуте ${choice.at}.`);
    }
  }

  function accept(raw: unknown): void {
    parseEventV1(raw);
    contractEvents.push(raw);
    contractEventCount += 1;
  }

  const orders: OrderRecord[] = [];
  const norms: NormRecord[] = [];
  for (const order of catalog) {
    if (order.arrivesAt >= horizonEnd) {
      continue;
    }
    const recordedAt = order.arrivesAt;
    const launched = launchMinuteOf(order);
    accept({
      version: 1,
      type: 'order-registered',
      author: 'commercial',
      flow: 'into-system',
      orderId: order.id,
      recordedAt,
    });
    accept({
      version: 1,
      type: 'route-approved',
      author: 'technologist',
      flow: 'into-system',
      orderId: order.id,
      recordedAt,
    });
    orders.push({
      id: order.id,
      status: launched !== null && launched < horizonEnd ? orderStatus(order) : 'unparsed',
      contractDue: order.contractDue === null ? null : instant(order.contractDue),
    });
    if (order.designDoc) {
      accept({
        version: 1,
        type: 'design-doc-recorded',
        author: 'archivist',
        flow: 'into-system',
        orderId: order.id,
        recordedAt,
      });
    }
    if (order.material) {
      accept({
        version: 1,
        type: 'material-arrived',
        author: 'storekeeper',
        flow: 'into-system',
        orderId: order.id,
        trueTime: recordedAt,
        recordTime: recordedAt,
      });
    }
    if (!order.norms) {
      continue;
    }
    norms.push({ orderId: order.id, operationId: null, norm: quantity('norm-hour', ORDER_NORM_HOURS) });
    for (const batchId of order.batchIds) {
      for (const item of steps) {
        const operationId = `${batchId}-op-${item.sequence}`;
        accept({
          version: 1,
          type: 'norm-assigned',
          author: 'normer',
          flow: 'into-system',
          orderId: order.id,
          operationId,
          normHours: OPERATION_NORM_HOURS,
          recordedAt,
        });
        norms.push({ orderId: order.id, operationId, norm: quantity('norm-hour', OPERATION_NORM_HOURS) });
      }
    }
  }

  let shop = createShop();
  const dueByBatch = new Map<string, number | null>();
  const launches: ScheduledLaunch[] = [];
  for (const order of catalog) {
    if (order.arrivesAt >= horizonEnd) {
      continue;
    }
    for (const batchId of order.batchIds) {
      dueByBatch.set(batchId, order.contractDue);
    }
    const atLaunch = launchMinuteOf(order);
    if (atLaunch === null || atLaunch >= horizonEnd) {
      continue;
    }
    for (const batchId of order.batchIds) {
      const batch = {
        id: batchId,
        partId: 'part-1',
        qty: pieces(BATCH_PIECES),
        materialReady: order.material,
        designDocReady: order.designDoc,
      };
      if (atLaunch === 0) {
        shop = launchBatch(shop, batch);
      } else {
        launches.push({ at: atLaunch, due: order.contractDue, batch });
      }
    }
  }
  if (input.overlay === 'breakdown') {
    shop = addDowntime(shop, {
      id: 'scripted-breakdown',
      resourceId: BREAKDOWN_RESOURCE,
      from: instant(0),
      until: instant(BREAKDOWN_UNTIL),
      reason: 'breakdown',
    });
  }

  const rng = createRng(input.seed);
  const controlRng = createRng(input.seed);
  const shopRun = runShop({
    shop,
    dueByBatch,
    rng,
    controlRng,
    controlEnabled: input.overlay === 'scrap',
    horizonShifts: horizon,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(launches.length === 0 ? {} : { launches }),
  });

  const batchOrder = new Map<string, string>();
  for (const order of catalog) {
    for (const batchId of order.batchIds) {
      batchOrder.set(batchId, order.id);
    }
  }
  function orderIdOf(batchId: string): string {
    const orderId = batchOrder.get(batchId);
    if (!orderId) {
      throw new Error(`Партия «${batchId}» без заявки.`);
    }
    return orderId;
  }

  const facts: FactRecord[] = [];
  const cards: RouteCardOperation[] = [];
  const notes: { operationId: string; note: 'paper' | 'skip'; at: number }[] = [];

  for (const completion of shopRun.completions) {
    if (!completion.final) {
      continue;
    }
    if (completion.warehouse) {
      accept({
        version: 1,
        type: 'finished-goods-received',
        author: 'storekeeper',
        flow: 'into-system',
        orderId: orderIdOf(completion.batchId),
        trueTime: completion.at,
        recordTime: completion.at,
      });
      continue;
    }
    const draw = rule.outsideShare > 0 ? rng() : null;
    const decision = disciplineDecision(rule, draw);
    if (decision.miss !== null) {
      notes.push({ operationId: completion.operationId, note: decision.miss, at: completion.at });
      continue;
    }
    const outcome = markByDiscipline({
      operationId: completion.operationId,
      trueTime: instant(completion.at),
      piecesDone: completion.cumulativeDone,
      piecesScrap: completion.cumulativeScrap,
      discipline: decision.discipline,
    });
    if (outcome.systemEvent === null) {
      throw new Error('Записанная отметка не создала событие.');
    }
    accept(outcome.systemEvent);
    facts.push({
      id: `fact-${completion.operationId}`,
      orderId: orderIdOf(completion.batchId),
      operationId: completion.operationId,
      author: 'master',
      trueTime: instant(outcome.systemEvent.trueTime),
      recordTime: instant(outcome.systemEvent.recordTime),
    });
    cards.push({
      operationId: completion.operationId,
      technology: null,
      production: null,
      control: null,
      totals: { done: pieces(completion.cumulativeDone), scrap: pieces(completion.cumulativeScrap) },
    });
  }

  function factVisible(operationId: string, at: number): boolean {
    return facts.some((fact) => fact.operationId === operationId && fact.recordTime <= at);
  }

  function knownQueue(at: number): QueueRow[] {
    const rows: QueueRow[] = [];
    for (const order of catalog) {
      if (order.arrivesAt > at || !takenBy(order, at)) {
        continue;
      }
      if (!order.material || !order.designDoc || !order.norms) {
        continue;
      }
      for (const batchId of order.batchIds) {
        for (const item of steps) {
          if (item.step.effort === null) {
            throw new Error(`У операции маршрута «${item.step.areaId}» нет длительности.`);
          }
          const operationId = `${batchId}-op-${item.sequence}`;
          const norm = norms.find((row) => row.operationId === operationId);
          if (!norm) {
            continue;
          }
          if (factVisible(operationId, at)) {
            continue;
          }
          if (item.sequence > 0 && !factVisible(`${batchId}-op-${item.sequence - 1}`, at)) {
            continue;
          }
          rows.push({ operationId, areaId: item.step.areaId, effort: item.step.effort, norm: norm.norm });
        }
      }
    }
    return rows;
  }

  function calculatedDue(order: StandOrder, at: number): SimInstant | null {
    if (order.contractDue === null || !order.norms || !order.material || !order.designDoc) {
      return null;
    }
    let minutes = 0;
    for (const batchId of order.batchIds) {
      for (const item of steps) {
        if (factVisible(`${batchId}-op-${item.sequence}`, at)) {
          continue;
        }
        minutes += occupationMinutes(item.step.effort);
      }
    }
    return instant(at + minutes);
  }

  let history: readonly PlanVersion[] = [];
  const snapshots: ShiftSnapshot[] = [];
  let areaLoads: AreaLoadRecord[] = [];
  for (let index = 0; index < horizon; index += 1) {
    const at = index * SHIFT_MINUTES;
    const version: PlanVersion = {
      id: `plan-shift-${index}`,
      createdAt: instant(at),
      reason: 'утверждение смены',
      orderDue: catalog.filter((order) => order.arrivesAt <= at).map((order) => ({
        orderId: order.id,
        calculatedDue: calculatedDue(order, at),
      })),
    };
    history = appendVersion(history, version);
    const queue = knownQueue(at);
    const snapshot = approveShift(version, {
      id: `shift-${index}`,
      shiftIndex: index,
      approvedAt: instant(at),
      sourceVersionId: version.id,
      lines: queue.map((row) => ({ operationId: row.operationId, norm: row.norm })),
    });
    snapshots.push(snapshot);
    accept({
      version: 1,
      type: 'plan-issued',
      author: 'pdo',
      flow: 'into-plant',
      versionId: version.id,
      issuedAt: at,
    });
    accept({
      version: 1,
      type: 'shift-task-issued',
      author: 'pdo',
      flow: 'into-plant',
      snapshotId: snapshot.id,
      issuedAt: at,
    });
    areaLoads = steps.map((item) => {
      if (item.step.effort === null) {
        throw new Error(`У участка «${item.step.areaId}» нет загрузки.`);
      }
      const rows = queue.filter((row) => row.areaId === item.step.areaId);
      const amount = rows.reduce((sum, row) => sum + row.effort.amount, 0);
      return {
        areaId: item.step.areaId,
        areaName: item.step.areaName,
        capacity: capacityOf(item.step),
        plan: amountOf(item.step.effort.kind, amount),
        queue: amountOf(item.step.effort.kind, amount),
      };
    });
  }

  const planDates: PlanDateRecord[] = [];
  for (const version of history) {
    for (const row of version.orderDue) {
      planDates.push({
        orderId: row.orderId,
        versionId: version.id,
        createdAt: version.createdAt,
        calculatedDue: row.calculatedDue,
      });
    }
  }

  const records: SystemRecords = { orders, norms, facts, areaLoads, planDates, cards };
  const levelArgs = {
    orders: orders.length,
    areas: EXPECTED.loadAreas,
    shiftFacts: EXPECTED.marks,
  };
  const lastWindow = shiftWindow(horizon - 1, horizon);
  const metrics = fourMetrics(records, levelArgs, lastWindow);
  const acceptedByShift = [];
  for (let index = 0; index < horizon; index += 1) {
    const window = shiftWindow(index, horizon);
    const metric = acceptedShift(records, window, EXPECTED.marks);
    acceptedByShift.push({
      index,
      normHours: metric.value.normHours,
      operationIds: records.facts
        .filter((fact) => inShift(fact.recordTime, window))
        .map((fact) => fact.operationId)
        .sort(byText),
    });
  }
  const warehouseOrders = [
    ...new Set(shopRun.completions.filter((completion) => completion.warehouse).map((completion) => orderIdOf(completion.batchId))),
  ].sort(byText);

  let report = buildReport({
    horizonShifts: horizon,
    seed: input.seed,
    level: input.level,
    overlay: input.overlay,
    outsideShare: rule.outsideShare,
    contractEventCount,
    shop: shopRun.shop,
    completions: shopRun.completions,
    starts: shopRun.starts,
    readyAtShift: shopRun.readyAtShift,
    failureBusyMinute: shopRun.failureBusyMinute,
    notes,
    facts,
    acceptedByShift,
    warehouseOrders,
    metrics,
  });

  let reportJson = JSON.stringify(report);
  if (reportJson.length > COMPLETION_BASELINE_BYTES * COMPLETION_GROWTH_LIMIT) {
    report = {
      ...report,
      shopCompletions: groupCompletions(report.shopCompletions),
    };
    reportJson = JSON.stringify(report);
  }

  const decisionJournal = choices.map((choice) => orderDecisionRecord({
    type: choice.type,
    orderId: choice.orderId,
    at: choice.at,
    basisMetric: choice.basisMetric,
    basisValue: JSON.stringify(metrics.portfolio.value),
    coverage: metrics.portfolio.coverage,
  }));

  return {
    report,
    reportJson,
    shop: shopRun.shop,
    records,
    snapshots,
    versions: history,
    starts: shopRun.starts,
    decisionJournal,
    contractEvents,
    completions: shopRun.completions,
  };
}

function buildReport(input: {
  readonly horizonShifts: number;
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly outsideShare: number;
  readonly contractEventCount: number;
  readonly shop: PlantState;
  readonly completions: readonly ShopCompletion[];
  readonly starts: readonly ShopStart[];
  readonly readyAtShift: readonly { readonly index: number; readonly operationIds: readonly string[] }[];
  readonly failureBusyMinute: readonly { readonly resourceId: string; readonly busyMinute: number }[];
  readonly notes: readonly { readonly operationId: string; readonly note: 'paper' | 'skip'; readonly at: number }[];
  readonly facts: readonly FactRecord[];
  readonly acceptedByShift: readonly { readonly index: number; readonly normHours: number; readonly operationIds: readonly string[] }[];
  readonly warehouseOrders: readonly string[];
  readonly metrics: {
    readonly portfolio: MetricResult<PortfolioValue>;
    readonly overload: MetricResult<OverloadValue>;
    readonly acceptedShift: MetricResult<AcceptedShiftValue>;
    readonly scheduleRisk: MetricResult<ScheduleRiskValue>;
  };
}): RunReport {
  const shopCompletions = [...input.completions]
    .sort((left, right) => left.at - right.at || byText(left.operationId, right.operationId))
    .map((completion) => ({
      operationId: completion.operationId,
      at: completion.at,
      done: completion.done,
      scrap: completion.scrap,
      warehouse: completion.warehouse,
    }));
  const firstByResource = new Map<string, ShopStart>();
  for (const start of input.starts) {
    const current = firstByResource.get(start.resourceId);
    if (!current || start.at < current.at || (start.at === current.at && start.operationId < current.operationId)) {
      firstByResource.set(start.resourceId, start);
    }
  }
  const notes = [...input.notes].sort((left, right) => left.at - right.at || byText(left.operationId, right.operationId));
  const facts = [...input.facts]
    .map((fact) => ({ operationId: fact.operationId, trueTime: fact.trueTime, recordTime: fact.recordTime }))
    .sort((left, right) => left.trueTime - right.trueTime || byText(left.operationId, right.operationId));
  const shifts = [];
  for (let index = 0; index < input.horizonShifts; index += 1) {
    const window = shiftWindow(index, input.horizonShifts);
    const ready = input.readyAtShift.find((row) => row.index === index);
    shifts.push({
      index,
      shopReady: ready ? [...ready.operationIds] : [],
      shopCompleted: shopCompletions
        .filter((completion) => !completion.warehouse && inShift(instant(completion.at), window))
        .map((completion) => completion.operationId)
        .sort(byText),
      recordedFacts: facts
        .filter((fact) => inShift(instant(fact.recordTime), window))
        .map((fact) => fact.operationId)
        .sort(byText),
    });
  }
  return {
    seed: input.seed,
    level: input.level,
    overlay: input.overlay,
    expected: { orders: EXPECTED.orders, loadAreas: EXPECTED.loadAreas, marks: EXPECTED.marks },
    parameters: {
      horizonShifts: input.horizonShifts,
      batchPieces: BATCH_PIECES,
      mtbfBusyMinutes: MACHINE_MTBF_BUSY_MINUTES,
      repairMinutes: REPAIR_MINUTES,
      outsideShare: input.outsideShare,
    },
    contractEventCount: input.contractEventCount,
    failureBusyMinute: [...input.failureBusyMinute].sort((left, right) => byText(left.resourceId, right.resourceId)),
    downtimes: [...input.shop.downtimes]
      .map((downtime) => ({
        id: downtime.id,
        resourceId: downtime.resourceId,
        from: downtime.from,
        until: downtime.until,
        reason: downtime.reason,
      }))
      .sort((left, right) => left.from - right.from || byText(left.resourceId, right.resourceId) || byText(left.id, right.id)),
    shopCompletions,
    firstStarts: [...firstByResource.values()]
      .map((start) => ({ resourceId: start.resourceId, operationId: start.operationId, at: start.at }))
      .sort((left, right) => byText(left.resourceId, right.resourceId)),
    notes,
    facts,
    shifts,
    acceptedByShift: input.acceptedByShift,
    warehouseOrders: input.warehouseOrders,
    metrics: {
      portfolio: {
        openCount: input.metrics.portfolio.value.openCount,
        remainderNormHours: input.metrics.portfolio.value.remainderNormHours,
        ordersWithoutNorm: input.metrics.portfolio.value.ordersWithoutNorm,
        coverage: input.metrics.portfolio.coverage,
      },
      overload: {
        overloadedCount: input.metrics.overload.value.overloadedCount,
        coverage: input.metrics.overload.coverage,
      },
      acceptedShift: {
        shiftIndex: input.horizonShifts - 1,
        normHours: input.metrics.acceptedShift.value.normHours,
        coverage: input.metrics.acceptedShift.coverage,
      },
      scheduleRisk: {
        overdue: input.metrics.scheduleRisk.value.overdue,
        onTime: input.metrics.scheduleRisk.value.onTime,
        unevaluated: input.metrics.scheduleRisk.value.unevaluated,
        coverage: input.metrics.scheduleRisk.coverage,
      },
    },
  };
}
