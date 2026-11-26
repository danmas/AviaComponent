import { markByDiscipline } from '../contract/discipline.ts';
import { parseEventV1 } from '../contract/v1/events.ts';
import { createRng } from '../contract/rng.ts';
import { pieces } from '../contract/quantity.ts';
import { assertStandInSpec, CONTRACT_STAND } from '../contract/stand.ts';
import { inShift, instant, SHIFT_MINUTES, shiftWindow, type SimInstant } from '../contract/time.ts';
import { quantity, type AnyQuantity, type UnitKind } from '../contract/units.ts';
import { launchBatch, tearOffBatch } from '../plant/batch.ts';
import { MACHINE_MTBF_BUSY_MINUTES, REPAIR_MINUTES, runShop, type ShopCompletion, type ShopStart } from '../plant/engine.ts';
import { occupationMinutes } from '../plant/occupation.ts';
import { ROUTE, type RouteStep } from '../plant/stand.ts';
import { addDowntime, createShop, type PlantState } from '../plant/state.ts';
import { appendVersion, approveShift, type PlanVersion, type ShiftSnapshot } from '../system/plan.ts';
import {
  acceptedShift,
  fourMetrics,
  type AcceptedShiftValue,
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
  SCRAP_CHILD,
  SCRAP_CHILD_PIECES,
  SCRAP_OPERATION,
  SCRAP_PARENT,
  SCRAP_PIECES,
  type StandOrder,
} from './catalog.ts';
import { disciplineDecision, EXPECTED, LEVEL_RULES, type LevelName, type OverlayName } from './levels.ts';

const ORDER_NORM_HOURS = 6;
const OPERATION_NORM_HOURS = 1;

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

export interface RunResult {
  readonly report: RunReport;
  readonly reportJson: string;
  readonly shop: PlantState;
  readonly records: SystemRecords;
  readonly snapshots: readonly ShiftSnapshot[];
  readonly versions: readonly PlanVersion[];
  readonly starts: readonly ShopStart[];
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

function orderStatus(order: StandOrder): OrderRecord['status'] {
  return order.material && order.designDoc && order.norms ? 'in-production' : 'dse';
}

export function runStand(input: { readonly seed: number; readonly level: LevelName; readonly overlay: OverlayName }): RunResult {
  assertStandInSpec();
  const rule = LEVEL_RULES[input.level];
  const catalog = ordersFor(input.level, input.overlay);
  const steps = processingSteps();
  let contractEventCount = 0;

  function accept(raw: unknown): void {
    parseEventV1(raw);
    contractEventCount += 1;
  }

  const orders: OrderRecord[] = [];
  const norms: NormRecord[] = [];
  for (const order of catalog) {
    accept({
      version: 1,
      type: 'order-registered',
      author: 'commercial',
      flow: 'into-system',
      orderId: order.id,
      recordedAt: 0,
    });
    accept({
      version: 1,
      type: 'route-approved',
      author: 'technologist',
      flow: 'into-system',
      orderId: order.id,
      recordedAt: 0,
    });
    orders.push({
      id: order.id,
      status: orderStatus(order),
      contractDue: order.contractDue === null ? null : instant(order.contractDue),
    });
    if (order.designDoc) {
      accept({
        version: 1,
        type: 'design-doc-recorded',
        author: 'archivist',
        flow: 'into-system',
        orderId: order.id,
        recordedAt: 0,
      });
    }
    if (order.material) {
      accept({
        version: 1,
        type: 'material-arrived',
        author: 'storekeeper',
        flow: 'into-system',
        orderId: order.id,
        trueTime: 0,
        recordTime: 0,
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
          recordedAt: 0,
        });
        norms.push({ orderId: order.id, operationId, norm: quantity('norm-hour', OPERATION_NORM_HOURS) });
      }
    }
  }

  let shop = createShop();
  const dueByBatch = new Map<string, number | null>();
  for (const order of catalog) {
    for (const batchId of order.batchIds) {
      shop = launchBatch(shop, {
        id: batchId,
        partId: 'part-1',
        qty: pieces(BATCH_PIECES),
        materialReady: order.material,
        designDocReady: order.designDoc,
      });
      dueByBatch.set(batchId, order.contractDue);
    }
  }
  const scrapByOperation = new Map<string, number>();
  if (input.overlay === 'scrap') {
    shop = tearOffBatch(shop, SCRAP_PARENT, SCRAP_CHILD, pieces(SCRAP_CHILD_PIECES), 'defect-sheet');
    const parentDue = dueByBatch.get(SCRAP_PARENT);
    dueByBatch.set(SCRAP_CHILD, parentDue === undefined ? null : parentDue);
    scrapByOperation.set(SCRAP_OPERATION, SCRAP_PIECES);
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
  const shopRun = runShop({
    shop,
    dueByBatch,
    scrapByOperation,
    rng,
    horizonShifts: CONTRACT_STAND.horizonShifts,
  });

  const batchOrder = new Map<string, string>();
  for (const order of catalog) {
    for (const batchId of order.batchIds) {
      batchOrder.set(batchId, order.id);
    }
  }
  if (input.overlay === 'scrap') {
    batchOrder.set(SCRAP_CHILD, 'order-1');
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
      piecesDone: completion.done,
      piecesScrap: completion.scrap,
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
      totals: { done: pieces(completion.done), scrap: pieces(completion.scrap) },
    });
  }

  function factVisible(operationId: string, at: number): boolean {
    return facts.some((fact) => fact.operationId === operationId && fact.recordTime <= at);
  }

  function knownQueue(at: number): QueueRow[] {
    const rows: QueueRow[] = [];
    for (const order of catalog) {
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
  for (let index = 0; index < CONTRACT_STAND.horizonShifts; index += 1) {
    const at = index * SHIFT_MINUTES;
    const version: PlanVersion = {
      id: `plan-shift-${index}`,
      createdAt: instant(at),
      reason: 'утверждение смены',
      orderDue: catalog.map((order) => ({
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
    orders: EXPECTED.orders,
    areas: EXPECTED.loadAreas,
    shiftFacts: EXPECTED.marks,
  };
  const lastWindow = shiftWindow(CONTRACT_STAND.horizonShifts - 1, CONTRACT_STAND.horizonShifts);
  const metrics = fourMetrics(records, levelArgs, lastWindow);
  const acceptedByShift = [];
  for (let index = 0; index < CONTRACT_STAND.horizonShifts; index += 1) {
    const window = shiftWindow(index, CONTRACT_STAND.horizonShifts);
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

  const report = buildReport({
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

  return {
    report,
    reportJson: JSON.stringify(report),
    shop: shopRun.shop,
    records,
    snapshots,
    versions: history,
    starts: shopRun.starts,
  };
}

function buildReport(input: {
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
  for (let index = 0; index < CONTRACT_STAND.horizonShifts; index += 1) {
    const window = shiftWindow(index, CONTRACT_STAND.horizonShifts);
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
      horizonShifts: CONTRACT_STAND.horizonShifts,
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
        shiftIndex: CONTRACT_STAND.horizonShifts - 1,
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
