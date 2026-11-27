import { inShift, type ShiftWindow } from '../contract/time.ts';
import type { SummarySlice } from '../contract/slices.ts';
import type { UnitKind } from '../contract/units.ts';
import type { FactRecord, PlanDateRecord, SystemRecords } from './types.ts';

/**
 * Показатели читают только записи Системы.
 * Ожидаемый объём приходит параметром уровня, не из состояния цеха.
 */
export const METRIC_READS = {
  portfolio: ['orders', 'norms', 'facts'],
  overload: ['areaLoads'],
  acceptedShift: ['facts', 'norms'],
  scheduleRisk: ['orders', 'planDates'],
} as const;

export type MetricId = keyof typeof METRIC_READS;

export interface MetricResult<T> {
  readonly id: MetricId;
  readonly value: T;
  readonly coverage: number;
  readonly reads: readonly string[];
}

export function coverage(present: number, expectedFromLevel: number): number {
  if (!Number.isInteger(expectedFromLevel) || expectedFromLevel <= 0) {
    throw new Error('Ожидаемое число задаётся параметром уровня и должно быть целым больше нуля.');
  }
  if (!Number.isInteger(present) || present < 0) {
    throw new Error('Число имеющихся записей должно быть целым и не меньше нуля.');
  }
  return present / expectedFromLevel;
}

export interface PortfolioValue {
  readonly openCount: number;
  readonly remainderNormHours: number;
  readonly ordersWithoutNorm: number;
}

export interface OverloadArea {
  readonly areaId: string;
  readonly areaName: string;
  readonly load: number | null;
  readonly overloaded: boolean;
  readonly queueUnit: UnitKind;
  readonly queueAmount: number;
  readonly problem: 'ok' | 'unit-mismatch' | 'zero-capacity';
}

export interface OverloadValue {
  readonly areas: readonly OverloadArea[];
  readonly overloadedCount: number;
  /** Суммы очереди только внутри одной единицы. Разные единицы не складываются. */
  readonly queueByUnit: readonly { readonly unit: UnitKind; readonly amount: number }[];
}

export interface AcceptedShiftValue {
  readonly normHours: number;
  readonly masterCloses: number;
  readonly workerCloses: number;
  readonly duplicateFacts: number;
}

export interface ScheduleRiskValue {
  readonly overdue: number;
  readonly onTime: number;
  readonly unevaluated: number;
}

function orderNorm(records: SystemRecords, orderId: string): number | null {
  const totals = records.norms.filter((norm) => norm.orderId === orderId && norm.operationId === null);
  if (totals.length === 0) {
    return null;
  }
  return totals.reduce((sum, norm) => sum + norm.norm.amount, 0);
}

function operationNorm(records: SystemRecords, operationId: string): number | null {
  const rows = records.norms.filter((norm) => norm.operationId === operationId);
  if (rows.length === 0) {
    return null;
  }
  return rows.reduce((sum, norm) => sum + norm.norm.amount, 0);
}

function distinctFacts(facts: readonly FactRecord[]): { kept: FactRecord[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: FactRecord[] = [];
  let duplicates = 0;
  for (const fact of facts) {
    if (seen.has(fact.operationId)) {
      duplicates += 1;
      continue;
    }
    seen.add(fact.operationId);
    kept.push(fact);
  }
  return { kept, duplicates };
}

export function portfolio(records: SystemRecords, expectedOrders: number): MetricResult<PortfolioValue> {
  const open = records.orders.filter((order) => order.status !== 'archive');
  // Неразобранный заказ уже в портфеле, но в числитель покрытия не входит.
  const counted = open.filter((order) => order.status !== 'unparsed');
  let remainderNormHours = 0;
  let ordersWithoutNorm = 0;
  for (const order of counted) {
    const total = orderNorm(records, order.id);
    if (total === null) {
      ordersWithoutNorm += 1;
      continue;
    }
    const accepted = distinctFacts(records.facts.filter((fact) => fact.orderId === order.id)).kept.reduce(
      (sum, fact) => {
        const norm = operationNorm(records, fact.operationId);
        return sum + (norm ?? 0);
      },
      0,
    );
    remainderNormHours += Math.max(0, total - accepted);
  }
  const present = counted.length - ordersWithoutNorm;
  return {
    id: 'portfolio',
    value: { openCount: open.length, remainderNormHours, ordersWithoutNorm },
    coverage: coverage(present, expectedOrders),
    reads: METRIC_READS.portfolio,
  };
}

/**
 * Участок в перегрузке, если записанная готовая очередь больше нуля.
 * Критерий «ровно шесть участков» живого экрана в документах не раскрыт и здесь не воспроизводится.
 */
export function overload(records: SystemRecords, expectedAreas: number): MetricResult<OverloadValue> {
  const areas: OverloadArea[] = records.areaLoads.map((row) => {
    const mismatch = row.plan.kind !== row.capacity.kind || row.queue.kind !== row.capacity.kind;
    const zero = !mismatch && row.capacity.amount === 0;
    const problem = mismatch ? 'unit-mismatch' : zero ? 'zero-capacity' : 'ok';
    const load = problem === 'ok' ? row.plan.amount / row.capacity.amount : null;
    return {
      areaId: row.areaId,
      areaName: row.areaName,
      load,
      overloaded: row.queue.amount > 0,
      queueUnit: row.queue.kind,
      queueAmount: row.queue.amount,
      problem,
    };
  });
  const byUnit = new Map<UnitKind, number>();
  for (const area of areas) {
    if (area.queueAmount === 0) {
      continue;
    }
    byUnit.set(area.queueUnit, (byUnit.get(area.queueUnit) ?? 0) + area.queueAmount);
  }
  const comparable = areas.filter((area) => area.problem === 'ok').length;
  return {
    id: 'overload',
    value: {
      areas,
      overloadedCount: areas.filter((area) => area.overloaded).length,
      queueByUnit: [...byUnit.entries()]
        .map(([unit, amount]) => ({ unit, amount }))
        .sort((left, right) => (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0)),
    },
    coverage: coverage(comparable, expectedAreas),
    reads: METRIC_READS.overload,
  };
}

/** «Принято за смену» считается по времени записи, не по истинному времени. */
export function acceptedShift(
  records: SystemRecords,
  window: ShiftWindow,
  expectedFacts: number,
): MetricResult<AcceptedShiftValue> {
  const inWindow = records.facts.filter((fact) => inShift(fact.recordTime, window));
  const { kept, duplicates } = distinctFacts(inWindow);
  let normHours = 0;
  let withNorm = 0;
  for (const fact of kept) {
    const norm = operationNorm(records, fact.operationId);
    if (norm === null) {
      continue;
    }
    normHours += norm;
    withNorm += 1;
  }
  return {
    id: 'acceptedShift',
    value: {
      normHours,
      masterCloses: kept.filter((fact) => fact.author === 'master').length,
      workerCloses: kept.filter((fact) => fact.author === 'worker').length,
      duplicateFacts: duplicates,
    },
    coverage: coverage(withNorm, expectedFacts),
    reads: METRIC_READS.acceptedShift,
  };
}

function latestPlan(records: SystemRecords, orderId: string): PlanDateRecord | null {
  const rows = records.planDates.filter((row) => row.orderId === orderId);
  if (rows.length === 0) {
    return null;
  }
  return [...rows].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.versionId < right.versionId ? -1 : left.versionId > right.versionId ? 1 : 0;
  }).at(-1) ?? null;
}

export function scheduleRisk(records: SystemRecords, expectedOrders: number): MetricResult<ScheduleRiskValue> {
  const open = records.orders.filter((order) => order.status !== 'archive');
  let overdue = 0;
  let onTime = 0;
  let unevaluated = 0;
  for (const order of open) {
    const plan = latestPlan(records, order.id);
    if (order.contractDue === null || plan === null || plan.calculatedDue === null) {
      unevaluated += 1;
      continue;
    }
    if (plan.calculatedDue > order.contractDue) {
      overdue += 1;
    } else {
      onTime += 1;
    }
  }
  return {
    id: 'scheduleRisk',
    value: { overdue, onTime, unevaluated },
    coverage: coverage(overdue + onTime, expectedOrders),
    reads: METRIC_READS.scheduleRisk,
  };
}

export interface FourMetrics {
  readonly portfolio: MetricResult<PortfolioValue>;
  readonly overload: MetricResult<OverloadValue>;
  readonly acceptedShift: MetricResult<AcceptedShiftValue>;
  readonly scheduleRisk: MetricResult<ScheduleRiskValue>;
}

export function fourMetrics(
  records: SystemRecords,
  level: { readonly orders: number; readonly areas: number; readonly shiftFacts: number },
  window: ShiftWindow,
): FourMetrics {
  return {
    portfolio: portfolio(records, level.orders),
    overload: overload(records, level.areas),
    acceptedShift: acceptedShift(records, window, level.shiftFacts),
    scheduleRisk: scheduleRisk(records, level.orders),
  };
}

export function summarySlice(metrics: FourMetrics): SummarySlice<FourMetrics> {
  return { layer: 'summary', metrics };
}

export function systemSeesOperation(records: SystemRecords, operationId: string): boolean {
  return records.facts.some((fact) => fact.operationId === operationId);
}
