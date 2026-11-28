import { SHIFT_MINUTES } from '../contract/time.ts';
import type { ShopCompletion, ShopStart } from '../plant/engine.ts';
import type { PlantBatch, PlantOperation } from '../plant/state.ts';
import type {
  AcceptedShiftValue,
  FourMetrics,
  PortfolioValue,
  ScheduleRiskValue,
} from '../system/metrics.ts';
import type { LevelName, OverlayName } from './levels.ts';

/**
 * Предупреждение для того, кто читает след отдельно от модели.
 * Текст совпадает с шапкой docs/TRACE-EXAMPLE.json: ключи шапки те же.
 */
export const TRACE_NOTE = 'Числа модельные. Структура и ключи — реальные, из срезов прогона.';

export interface TraceMeta {
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly horizonShifts: number;
  readonly shiftMinutes: number;
  readonly note: string;
}

export interface TraceOrderEvent {
  readonly at: number;
  readonly type: 'order-registered';
  readonly orderId: string;
  readonly contractDue: number | null;
}

export interface TraceBatchEvent {
  readonly at: number;
  readonly type: 'batch-appeared';
  readonly batchId: string;
  readonly orderId: string;
  readonly appearedAt: number;
  readonly qty: number;
}

export interface TraceReadyEvent {
  readonly at: number;
  readonly type: 'operation-ready';
  readonly operationId: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly readyAt: number;
}

export interface TraceStartedEvent {
  readonly at: number;
  readonly type: 'operation-started';
  readonly operationId: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly startedAt: number;
}

export interface TraceCompletedEvent {
  readonly at: number;
  readonly type: 'operation-completed';
  readonly operationId: string;
  readonly batchId: string;
  readonly done: number;
  readonly good: number;
}

/**
 * Одно и то же поле у обоих решений, как в docs/TRACE-EXAMPLE.json.
 * Приоритет заполняет ранг. Приём и отложение ранга не имеют: в поле null,
 * партия — та, которую заказ запускает. Пустое поле не выкидывается.
 */
export interface TraceDecisionEvent {
  readonly at: number;
  readonly type: 'decision-applied';
  readonly decisionType: 'priority' | 'accept-order' | 'defer-order';
  readonly batchId: string;
  readonly appliedAt: number;
  readonly rank: number | null;
}

export type TraceEvent =
  | TraceOrderEvent
  | TraceBatchEvent
  | TraceReadyEvent
  | TraceStartedEvent
  | TraceCompletedEvent
  | TraceDecisionEvent;

export interface TraceMetric<T> {
  readonly value: T;
  readonly coverage: number;
}

export interface TraceOverloadValue {
  readonly overloadedCount: number;
  readonly queueByUnit: readonly { readonly unit: string; readonly amount: number }[];
}

export interface TraceFrameBatch {
  readonly batchId: string;
  readonly areaId: string;
  readonly status: string;
  readonly waitedMinutes: number;
}

export interface TraceFrame {
  readonly shift: number;
  readonly at: number;
  readonly metrics: {
    readonly portfolio: TraceMetric<PortfolioValue>;
    readonly overload: TraceMetric<TraceOverloadValue>;
    readonly acceptedShift: TraceMetric<AcceptedShiftValue>;
    readonly scheduleRisk: TraceMetric<ScheduleRiskValue>;
  };
  readonly batches: readonly TraceFrameBatch[];
}

export interface Trace {
  readonly meta: TraceMeta;
  readonly events: readonly TraceEvent[];
  readonly frames: readonly TraceFrame[];
}

export type TraceDecision =
  | {
      readonly type: 'priority';
      readonly batchId: string;
      readonly rank: number;
      readonly appliedAt: number;
    }
  | {
      readonly type: 'accept-order' | 'defer-order';
      readonly orderId: string;
      readonly appliedAt: number;
    };

export interface TraceFrameSource {
  readonly shift: number;
  readonly metrics: FourMetrics;
  readonly batches: readonly PlantBatch[];
  readonly operations: readonly PlantOperation[];
}

export interface TraceBuildInput {
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  /** Горизонт сессии. В шапке, даже если сыграны ещё не все смены. */
  readonly horizonShifts: number;
  /** Сколько смен уже прогнано: горизонт последнего выданного среза. */
  readonly playedShifts: number;
  readonly orders: readonly {
    readonly id: string;
    readonly arrivesAt: number;
    readonly contractDue: number | null;
    readonly batchIds: readonly string[];
  }[];
  readonly batches: readonly PlantBatch[];
  readonly operations: readonly PlantOperation[];
  readonly starts: readonly ShopStart[];
  readonly completions: readonly ShopCompletion[];
  readonly decisions: readonly TraceDecision[];
  readonly frames: readonly TraceFrameSource[];
}

interface SortKey {
  readonly at: number;
  readonly group: number;
  readonly id: string;
  readonly phase: number;
  readonly index: number;
}

function byKey(left: SortKey, right: SortKey): number {
  if (left.at !== right.at) {
    return left.at - right.at;
  }
  if (left.group !== right.group) {
    return left.group - right.group;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  if (left.phase !== right.phase) {
    return left.phase - right.phase;
  }
  return left.index - right.index;
}

function requireOperation(operations: ReadonlyMap<string, PlantOperation>, operationId: string): PlantOperation {
  const operation = operations.get(operationId);
  if (operation === undefined) {
    throw new Error(`Операция «${operationId}» есть в ходе прогона и отсутствует в цехе.`);
  }
  return operation;
}

function frameOf(source: TraceFrameSource): TraceFrame {
  const boundary = source.shift * SHIFT_MINUTES;
  const batches: TraceFrameBatch[] = [];
  for (const batch of source.batches) {
    if (batch.appearedAt > boundary) {
      continue;
    }
    const ops = source.operations.filter((operation) => operation.batchId === batch.id);
    const current = ops.find((operation) => operation.status === 'running')
      ?? ops.find((operation) => operation.status === 'ready')
      ?? ops.find((operation) => operation.status === 'not-ready')
      ?? null;
    const done = ops.filter((operation) => operation.status === 'done');
    const lastDone = done.length === 0 ? null : done[done.length - 1] ?? null;
    const areaId = current?.areaId ?? lastDone?.areaId;
    if (areaId === undefined) {
      throw new Error(`У партии «${batch.id}» на смене ${source.shift} нет участка.`);
    }
    const readyAt = current?.readyAt ?? null;
    const waitedMinutes = current !== null && readyAt !== null && readyAt <= boundary ? boundary - readyAt : 0;
    batches.push({
      batchId: batch.id,
      areaId,
      status: current?.status ?? 'done',
      waitedMinutes,
    });
  }
  const metrics = source.metrics;
  return {
    shift: source.shift,
    at: boundary,
    metrics: {
      portfolio: {
        value: {
          openCount: metrics.portfolio.value.openCount,
          remainderNormHours: metrics.portfolio.value.remainderNormHours,
          ordersWithoutNorm: metrics.portfolio.value.ordersWithoutNorm,
        },
        coverage: metrics.portfolio.coverage,
      },
      overload: {
        value: {
          overloadedCount: metrics.overload.value.overloadedCount,
          queueByUnit: metrics.overload.value.queueByUnit.map((row) => ({ unit: row.unit, amount: row.amount })),
        },
        coverage: metrics.overload.coverage,
      },
      acceptedShift: {
        value: {
          normHours: metrics.acceptedShift.value.normHours,
          masterCloses: metrics.acceptedShift.value.masterCloses,
          workerCloses: metrics.acceptedShift.value.workerCloses,
          duplicateFacts: metrics.acceptedShift.value.duplicateFacts,
        },
        coverage: metrics.acceptedShift.coverage,
      },
      scheduleRisk: {
        value: {
          overdue: metrics.scheduleRisk.value.overdue,
          onTime: metrics.scheduleRisk.value.onTime,
          unevaluated: metrics.scheduleRisk.value.unevaluated,
        },
        coverage: metrics.scheduleRisk.coverage,
      },
    },
    batches,
  };
}

/**
 * След из уже посчитанного прогона и выданных срезов.
 * Очередь, садку и контроль не вызывает: только раскладывает то, что прогон уже записал.
 */
export function buildTrace(input: TraceBuildInput): Trace {
  const end = input.playedShifts * SHIFT_MINUTES;
  const orderOfBatch = new Map<string, string>();
  for (const order of input.orders) {
    for (const batchId of order.batchIds) {
      orderOfBatch.set(batchId, order.id);
    }
  }
  const operationOf = new Map(input.operations.map((operation) => [operation.id, operation]));
  const tagged: { readonly key: SortKey; readonly event: TraceEvent }[] = [];

  function push(key: Omit<SortKey, 'index'>, event: TraceEvent): void {
    tagged.push({ key: { ...key, index: tagged.length }, event });
  }

  for (const order of input.orders) {
    if (order.arrivesAt >= end) {
      continue;
    }
    push(
      { at: order.arrivesAt, group: 0, id: order.id, phase: 0 },
      { at: order.arrivesAt, type: 'order-registered', orderId: order.id, contractDue: order.contractDue },
    );
  }

  for (const batch of input.batches) {
    const orderId = orderOfBatch.get(batch.id);
    if (orderId === undefined) {
      throw new Error(`Партия «${batch.id}» без заявки.`);
    }
    push(
      { at: batch.appearedAt, group: 1, id: batch.id, phase: 0 },
      {
        at: batch.appearedAt,
        type: 'batch-appeared',
        batchId: batch.id,
        orderId,
        appearedAt: batch.appearedAt,
        qty: batch.qty,
      },
    );
  }

  for (const operation of input.operations) {
    if (operation.readyAt === null) {
      continue;
    }
    push(
      { at: operation.readyAt, group: 3, id: operation.id, phase: 0 },
      {
        at: operation.readyAt,
        type: 'operation-ready',
        operationId: operation.id,
        batchId: operation.batchId,
        areaId: operation.areaId,
        readyAt: operation.readyAt,
      },
    );
  }

  for (const start of input.starts) {
    const operation = requireOperation(operationOf, start.operationId);
    push(
      { at: start.at, group: 3, id: start.operationId, phase: 1 },
      {
        at: start.at,
        type: 'operation-started',
        operationId: start.operationId,
        batchId: operation.batchId,
        areaId: operation.areaId,
        startedAt: start.at,
      },
    );
  }

  for (const completion of input.completions) {
    const good = completion.done - completion.scrap;
    if (!Number.isInteger(completion.done) || !Number.isInteger(good) || good < 0 || good > completion.done) {
      throw new Error(`Порция «${completion.operationId}» не сходится: сделано ${completion.done}, годных ${good}.`);
    }
    push(
      { at: completion.at, group: 3, id: completion.operationId, phase: 2 },
      {
        at: completion.at,
        type: 'operation-completed',
        operationId: completion.operationId,
        batchId: completion.batchId,
        done: completion.done,
        good,
      },
    );
  }

  for (const decision of input.decisions) {
    if (decision.type === 'priority') {
      push(
        { at: decision.appliedAt, group: 2, id: decision.batchId, phase: 2 },
        {
          at: decision.appliedAt,
          type: 'decision-applied',
          decisionType: 'priority',
          batchId: decision.batchId,
          appliedAt: decision.appliedAt,
          rank: decision.rank,
        },
      );
      continue;
    }
    const order = input.orders.find((item) => item.id === decision.orderId);
    if (order === undefined || order.batchIds.length === 0) {
      throw new Error(`Решение по заказу «${decision.orderId}» без партии.`);
    }
    const phase = decision.type === 'accept-order' ? 0 : 1;
    for (const batchId of order.batchIds) {
      push(
        { at: decision.appliedAt, group: 2, id: batchId, phase },
        {
          at: decision.appliedAt,
          type: 'decision-applied',
          decisionType: decision.type,
          batchId,
          appliedAt: decision.appliedAt,
          rank: null,
        },
      );
    }
  }

  tagged.sort((left, right) => byKey(left.key, right.key));
  return {
    meta: {
      seed: input.seed,
      level: input.level,
      overlay: input.overlay,
      horizonShifts: input.horizonShifts,
      shiftMinutes: SHIFT_MINUTES,
      note: TRACE_NOTE,
    },
    events: tagged.map((row) => row.event),
    frames: input.frames.map(frameOf),
  };
}
