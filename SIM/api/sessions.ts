import { randomUUID } from 'node:crypto';

import { CONTRACT_STAND } from '../contract/stand.ts';
import type { RoleRecordsSlice, ShopSlice } from '../contract/slices.ts';
import { SHIFT_MINUTES, instant, shiftWindow } from '../contract/time.ts';
import type { UnitKind } from '../contract/units.ts';
import type { PriorityOrder } from '../plant/engine.ts';
import { shopSlice } from '../plant/state.ts';
import type { PlantState } from '../plant/state.ts';
import { ordersFor } from '../run/catalog.ts';
import { EXPECTED, LEVEL_NAMES, OVERLAY_NAMES, type LevelName, type OverlayName } from '../run/levels.ts';
import { type OrderChoice } from '../run/run.ts';
import { runStand } from '../run/run.ts';
import { orderDecisionRecord, recordDecision, type DecisionRecord } from '../system/journal.ts';
import { fourMetrics, summarySlice, type FourMetrics, type MetricId } from '../system/metrics.ts';
import type { SystemRecords } from '../system/types.ts';
import { replayWithinWindow, trimToWindow, type ReplaySlice } from './stream.ts';
import type { ApiVersion } from './version.ts';

export const DECISION_TYPES = ['priority', 'accept-order', 'defer-order'] as const;

const METRIC_IDS = ['portfolio', 'overload', 'acceptedShift', 'scheduleRisk'] as const satisfies readonly MetricId[];

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export interface QuantityPlain {
  readonly kind: UnitKind;
  readonly amount: number;
}

export interface SummaryArea {
  readonly areaId: string;
  readonly areaName: string;
  readonly capacity: QuantityPlain;
  readonly plan: QuantityPlain;
  readonly queue: QuantityPlain;
}

export interface ReliabilityRow {
  readonly id: MetricId;
  readonly coverage: number;
}

/** Реестр — те же покрытия, что уже лежат в показателях. Отдельной формулы нет. */
export interface SummaryBody {
  readonly layer: 'summary';
  readonly shift: number;
  readonly metrics: FourMetrics;
  readonly reliability: readonly ReliabilityRow[];
  readonly areas: readonly SummaryArea[];
}

export interface ShopBody extends ShopSlice<PlantState> {
  readonly shift: number;
}

export type RoleRow =
  | {
      readonly role: 'commercial';
      readonly kind: 'order';
      readonly ref: string;
      readonly at: null;
      readonly status: string;
      readonly contractDue: number | null;
    }
  | {
      readonly role: 'normer';
      readonly kind: 'norm';
      readonly ref: string;
      readonly at: null;
      readonly orderId: string;
      readonly operationId: string | null;
      readonly norm: QuantityPlain;
    }
  | {
      readonly role: 'master' | 'worker';
      readonly kind: 'fact';
      readonly ref: string;
      readonly at: number;
      readonly orderId: string;
      readonly operationId: string;
      readonly trueTime: number;
    }
  | {
      readonly role: 'pdo';
      readonly kind: 'plan-date';
      readonly ref: string;
      readonly at: number;
      readonly orderId: string;
      readonly versionId: string;
      readonly calculatedDue: number | null;
    }
  | {
      readonly role: 'technologist';
      readonly kind: 'card';
      readonly ref: string;
      readonly at: null;
      readonly operationId: string;
      readonly technology: string | null;
      readonly production: string | null;
      readonly control: string | null;
      readonly done: number | null;
      readonly scrap: number | null;
    }
  | {
      readonly role: 'pdo';
      readonly kind: 'area-load';
      readonly ref: string;
      readonly at: null;
      readonly areaName: string;
      readonly capacity: QuantityPlain;
      readonly plan: QuantityPlain;
      readonly queue: QuantityPlain;
    };

export interface RolesBody extends RoleRecordsSlice<RoleRow> {
  readonly shift: number;
}

export type DecisionRow =
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

export type SessionEvent =
  | { readonly seq: number; readonly at: number; readonly type: 'shift-started'; readonly payload: { readonly shift: number } }
  | { readonly seq: number; readonly at: number; readonly type: 'shift-completed'; readonly payload: { readonly shift: number } }
  | {
      readonly seq: number;
      readonly at: number;
      readonly type: 'metrics-updated';
      readonly payload: { readonly shift: number; readonly summary: SummaryBody };
    }
  | {
      readonly seq: number;
      readonly at: number;
      readonly type: 'decision-applied';
      readonly payload:
        | { readonly type: 'priority'; readonly batchId: string; readonly rank: number; readonly appliedAt: number }
        | { readonly type: 'accept-order' | 'defer-order'; readonly orderId: string; readonly appliedAt: number };
    }
  | {
      readonly seq: number;
      readonly at: number;
      readonly type: 'session-finished';
      readonly payload: { readonly shift: number; readonly horizonShifts: number };
    };

export interface SessionView {
  readonly id: string;
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly horizonShifts: number;
  readonly currentShift: number;
  readonly decisions: readonly DecisionRow[];
  readonly createdAt: string;
  readonly replayable: true;
  readonly summary: SummaryBody;
  readonly decisionJournal: readonly DecisionRecord[];
  /** Версия HTTP-контракта. Дублируется в теле: ответ может жить в файле, где пути уже нет. */
  readonly apiVersion?: ApiVersion;
}

export interface CreateSessionInput {
  readonly seed: number;
  readonly level: string;
  readonly overlay: string;
  readonly horizonShifts?: number;
}

export interface DecisionInput {
  readonly type: string;
  readonly batchId?: string;
  readonly rank?: number;
  readonly orderId?: string;
  readonly appliedAt?: number;
}

export interface Sender {
  send(data: string): void;
}

interface IssuedSlice {
  readonly summary: SummaryBody;
  readonly shop: ShopBody;
  readonly roles: RolesBody;
}

interface Session {
  readonly id: string;
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly horizonShifts: number;
  currentShift: number;
  readonly decisions: DecisionRow[];
  readonly createdAt: string;
  readonly issued: IssuedSlice[];
  readonly events: SessionEvent[];
  readonly decisionJournal: DecisionRecord[];
  nextSeq: number;
  readonly listeners: Set<Sender>;
}

function isLevel(value: string): value is LevelName {
  return (LEVEL_NAMES as readonly string[]).includes(value);
}

function isOverlay(value: string): value is OverlayName {
  return (OVERLAY_NAMES as readonly string[]).includes(value);
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function plainQuantity(value: { readonly kind: UnitKind; readonly amount: number }): QuantityPlain {
  return { kind: value.kind, amount: value.amount };
}

function reliabilityOf(metrics: FourMetrics): readonly ReliabilityRow[] {
  return METRIC_IDS.map((id) => ({ id, coverage: metrics[id].coverage }));
}

function roleRows(records: SystemRecords): RoleRow[] {
  const rows: RoleRow[] = [];
  for (const order of records.orders) {
    rows.push({
      role: 'commercial',
      kind: 'order',
      ref: order.id,
      at: null,
      status: order.status,
      contractDue: order.contractDue,
    });
  }
  for (const norm of records.norms) {
    rows.push({
      role: 'normer',
      kind: 'norm',
      ref: `${norm.orderId}:${norm.operationId ?? 'order'}`,
      at: null,
      orderId: norm.orderId,
      operationId: norm.operationId,
      norm: plainQuantity(norm.norm),
    });
  }
  for (const fact of records.facts) {
    rows.push({
      role: fact.author,
      kind: 'fact',
      ref: fact.id,
      at: fact.recordTime,
      orderId: fact.orderId,
      operationId: fact.operationId,
      trueTime: fact.trueTime,
    });
  }
  for (const plan of records.planDates) {
    rows.push({
      role: 'pdo',
      kind: 'plan-date',
      ref: `${plan.versionId}:${plan.orderId}`,
      at: plan.createdAt,
      orderId: plan.orderId,
      versionId: plan.versionId,
      calculatedDue: plan.calculatedDue,
    });
  }
  for (const card of records.cards) {
    rows.push({
      role: 'technologist',
      kind: 'card',
      ref: card.operationId,
      at: null,
      operationId: card.operationId,
      technology: card.technology,
      production: card.production,
      control: card.control,
      done: card.totals === null ? null : card.totals.done,
      scrap: card.totals === null ? null : card.totals.scrap,
    });
  }
  for (const load of records.areaLoads) {
    rows.push({
      role: 'pdo',
      kind: 'area-load',
      ref: load.areaId,
      at: null,
      areaName: load.areaName,
      capacity: plainQuantity(load.capacity),
      plan: plainQuantity(load.plan),
      queue: plainQuantity(load.queue),
    });
  }
  return rows;
}

/**
 * Срез на смену — прогон с горизонтом shift+1.
 * Мощность копируется из AreaLoadRecord, обработчик её не считает.
 * Выданный снимок хранится: решение на этой же смене меняет следующий перепрогон,
 * а уже отданный срез остаётся прежним.
 */
function buildSlice(input: {
  readonly seed: number;
  readonly level: LevelName;
  readonly overlay: OverlayName;
  readonly shift: number;
  readonly priority: readonly PriorityOrder[];
  readonly orderChoices: readonly OrderChoice[];
}): IssuedSlice {
  const horizonShifts = input.shift + 1;
  const result = runStand({
    seed: input.seed,
    level: input.level,
    overlay: input.overlay,
    horizonShifts,
    priority: input.priority,
    ...(input.orderChoices.length === 0 ? {} : { orderChoices: input.orderChoices }),
  });
  const metrics = fourMetrics(
    result.records,
    { orders: result.records.orders.length, areas: EXPECTED.loadAreas, shiftFacts: EXPECTED.marks },
    shiftWindow(input.shift, horizonShifts),
  );
  const base = summarySlice(metrics);
  return snapshot({
    summary: {
      layer: base.layer,
      shift: input.shift,
      metrics: base.metrics,
      reliability: reliabilityOf(metrics),
      areas: result.records.areaLoads.map((row) => ({
        areaId: row.areaId,
        areaName: row.areaName,
        capacity: plainQuantity(row.capacity),
        plan: plainQuantity(row.plan),
        queue: plainQuantity(row.queue),
      })),
    },
    shop: { ...shopSlice(result.shop), shift: input.shift },
    roles: { layer: 'roles', shift: input.shift, records: roleRows(result.records) },
  });
}

function priorityFor(session: Session, shift: number): PriorityOrder[] {
  const until = shift * SHIFT_MINUTES;
  const rows: PriorityOrder[] = [];
  for (const decision of session.decisions) {
    if (decision.type !== 'priority' || decision.appliedAt > until) {
      continue;
    }
    rows.push({ batchId: decision.batchId, rank: decision.rank, appliedAt: decision.appliedAt });
  }
  return rows;
}

function orderChoicesFor(session: Session, shift: number): OrderChoice[] {
  const until = shift * SHIFT_MINUTES;
  const rows: OrderChoice[] = [];
  for (const decision of session.decisions) {
    if ((decision.type !== 'accept-order' && decision.type !== 'defer-order') || decision.appliedAt > until) {
      continue;
    }
    rows.push({
      type: decision.type,
      orderId: decision.orderId,
      at: decision.appliedAt,
      basisMetric: 'portfolio',
    });
  }
  return rows;
}

function issue(session: Session, force = false): IssuedSlice {
  const existing = session.issued[session.currentShift];
  if (existing !== undefined && !force) {
    return existing;
  }
  const slice = buildSlice({
    seed: session.seed,
    level: session.level,
    overlay: session.overlay,
    shift: session.currentShift,
    priority: priorityFor(session, session.currentShift),
    orderChoices: orderChoicesFor(session, session.currentShift),
  });
  session.issued[session.currentShift] = slice;
  return slice;
}

function issuedFor(session: Session, shift: number | undefined): IssuedSlice {
  const index = shift ?? session.currentShift;
  if (!Number.isInteger(index) || index < 0) {
    throw new ApiError(400, 'Номер смены — целое число от нуля.');
  }
  const slice = session.issued[index];
  if (slice === undefined) {
    throw new ApiError(400, `Срез смены ${index} ещё не выдан.`);
  }
  return slice;
}

function publish(session: Session, event: Omit<SessionEvent, 'seq'>): SessionEvent {
  const stored = { ...event, seq: session.nextSeq } as SessionEvent;
  session.nextSeq += 1;
  session.events.push(stored);
  trimToWindow(session.events);
  const text = JSON.stringify(stored);
  for (const listener of [...session.listeners]) {
    try {
      listener.send(text);
    } catch {
      session.listeners.delete(listener);
    }
  }
  return stored;
}

function view(session: Session, shift?: number): SessionView {
  const slice = issuedFor(session, shift);
  return {
    id: session.id,
    seed: session.seed,
    level: session.level,
    overlay: session.overlay,
    horizonShifts: session.horizonShifts,
    currentShift: session.currentShift,
    decisions: session.decisions.map((row) => ({ ...row })),
    createdAt: session.createdAt,
    replayable: true,
    summary: slice.summary,
    decisionJournal: session.decisionJournal.map((row) => ({
      at: row.at,
      action: row.action,
      basisMetric: row.basisMetric,
      basisValue: row.basisValue,
      coverage: row.coverage,
      consequence: row.consequence,
    })),
  };
}

function horizonMessage(): string {
  return `Горизонт сессии — целое число от ${CONTRACT_STAND.horizonShiftsMin} до ${CONTRACT_STAND.horizonShiftsMax} смен.`;
}

export interface SessionStore {
  create(input: CreateSessionInput): SessionView;
  view(id: string, shift?: number): SessionView;
  shop(id: string, shift?: number): ShopBody;
  roles(id: string, shift?: number): RolesBody;
  decide(id: string, input: DecisionInput): { decision: DecisionRow; journal: DecisionRecord; event: SessionEvent };
  advance(id: string): { currentShift: number; summary: SummaryBody; events: readonly SessionEvent[] };
  replay(id: string, lastSeq: number): ReplaySlice<SessionEvent>;
  attach(id: string, sender: Sender, lastSeq: number, options?: { replay?: boolean }): void;
  detach(id: string, sender: Sender): void;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  function take(id: string): Session {
    const session = sessions.get(id);
    if (session === undefined) {
      throw new ApiError(404, 'Сессия не найдена.');
    }
    return session;
  }

  return {
    create(input) {
      if (!Number.isInteger(input.seed)) {
        throw new ApiError(400, 'Seed должен быть целым числом.');
      }
      if (!isLevel(input.level)) {
        throw new ApiError(400, `Уровень отметки неизвестен. Допустимые уровни: ${LEVEL_NAMES.join(', ')}.`);
      }
      if (!isOverlay(input.overlay)) {
        throw new ApiError(400, `Помеха неизвестна. Допустимые помехи: ${OVERLAY_NAMES.join(', ')}.`);
      }
      const horizonShifts = input.horizonShifts ?? CONTRACT_STAND.horizonShifts;
      if (!Number.isInteger(horizonShifts) || horizonShifts < CONTRACT_STAND.horizonShiftsMin || horizonShifts > CONTRACT_STAND.horizonShiftsMax) {
        throw new ApiError(400, horizonMessage());
      }
      const session: Session = {
        id: randomUUID(),
        seed: input.seed,
        level: input.level,
        overlay: input.overlay,
        horizonShifts,
        currentShift: 0,
        decisions: [],
        createdAt: new Date().toISOString(),
        issued: [],
        events: [],
        decisionJournal: [],
        nextSeq: 1,
        listeners: new Set(),
      };
      issue(session);
      sessions.set(session.id, session);
      return view(session);
    },

    view(id, shift) {
      return view(take(id), shift);
    },

    shop(id, shift) {
      return issuedFor(take(id), shift).shop;
    },

    roles(id, shift) {
      return issuedFor(take(id), shift).roles;
    },

    decide(id, input) {
      const session = take(id);
      if (!(DECISION_TYPES as readonly string[]).includes(input.type)) {
        throw new ApiError(400, `Неизвестный тип решения «${input.type}». Допустимые типы: ${DECISION_TYPES.join(', ')}.`);
      }
      const appliedAt = session.currentShift * SHIFT_MINUTES;
      if (input.appliedAt !== undefined) {
        if (!Number.isInteger(input.appliedAt)) {
          throw new ApiError(400, 'Момент применения решения — целое число минут.');
        }
        if (input.appliedAt < appliedAt) {
          throw new ApiError(409, 'Решение с моментом применения раньше текущей смены отклонено.');
        }
        if (input.appliedAt > appliedAt) {
          throw new ApiError(400, 'Решение применяется на текущую смену. Момент задаёт сервер.');
        }
      }
      const seen = issuedFor(session, session.currentShift);
      if (input.type === 'accept-order' || input.type === 'defer-order') {
        const orderType = input.type;
        const orderId = (input.orderId ?? '').trim();
        if (orderId.length === 0) {
          throw new ApiError(400, 'Решение по заказу требует идентификатор заказа.');
        }
        const order = ordersFor(session.level, session.overlay).find((item) => item.id === orderId);
        if (order === undefined) {
          throw new ApiError(400, `Заказа «${orderId}» в этом прогоне нет.`);
        }
        if (order.acceptedByDefault) {
          throw new ApiError(409, `Заказ «${order.id}» уже принят.`);
        }
        if (order.arrivesAt > appliedAt) {
          throw new ApiError(409, `Заказ «${order.id}» ещё не поступил.`);
        }
        const book = seen.summary.metrics.portfolio;
        const journal = orderDecisionRecord({
          type: orderType,
          orderId,
          at: appliedAt,
          basisMetric: 'portfolio',
          basisValue: JSON.stringify(book.value),
          coverage: book.coverage,
        });
        const decision: DecisionRow = { type: orderType, orderId, appliedAt };
        session.decisions.push(decision);
        session.decisionJournal.push(journal);
        const event = publish(session, {
          at: appliedAt,
          type: 'decision-applied',
          payload: { type: orderType, orderId, appliedAt },
        });
        // Срез этой смены пересобирается: решение датировано её началом,
        // партии должны быть видны в ней же. Прошлые смены не трогаются.
        // Решение о приоритете по-прежнему выданный срез не переписывает.
        issue(session, true);
        return { decision, journal, event };
      }
      const batchId = (input.batchId ?? '').trim();
      if (batchId.length === 0) {
        throw new ApiError(400, 'Решение о приоритете требует партию.');
      }
      const rank = input.rank;
      if (typeof rank !== 'number' || !Number.isInteger(rank)) {
        throw new ApiError(400, 'Ранг приоритета — целое число.');
      }
      const risk = seen.summary.metrics.scheduleRisk;
      const journal = recordDecision({
        at: instant(appliedAt),
        action: `приоритет партии ${batchId}: ранг ${rank}`,
        basisMetric: 'scheduleRisk',
        basisValue: JSON.stringify(risk.value),
        coverage: risk.coverage,
        consequence: 'ранг действует с начала этой смены; уже выданный срез не пересчитывается',
      });
      const decision: DecisionRow = { type: 'priority', batchId, rank, appliedAt };
      session.decisions.push(decision);
      session.decisionJournal.push(journal);
      const event = publish(session, {
        at: appliedAt,
        type: 'decision-applied',
        payload: { type: 'priority', batchId, rank, appliedAt },
      });
      return { decision, journal, event };
    },

    advance(id) {
      const session = take(id);
      if (session.currentShift >= session.horizonShifts - 1) {
        throw new ApiError(409, 'Сессия дошла до последней смены горизонта.');
      }
      session.currentShift += 1;
      const at = session.currentShift * SHIFT_MINUTES;
      const produced: SessionEvent[] = [];
      produced.push(publish(session, { at, type: 'shift-started', payload: { shift: session.currentShift } }));
      const slice = issue(session);
      produced.push(publish(session, { at, type: 'shift-completed', payload: { shift: session.currentShift } }));
      produced.push(publish(session, {
        at,
        type: 'metrics-updated',
        payload: { shift: session.currentShift, summary: slice.summary },
      }));
      if (session.currentShift === session.horizonShifts - 1) {
        produced.push(publish(session, {
          at,
          type: 'session-finished',
          payload: { shift: session.currentShift, horizonShifts: session.horizonShifts },
        }));
      }
      return { currentShift: session.currentShift, summary: slice.summary, events: produced };
    },

    attach(id, sender, lastSeq, options) {
      const session = take(id);
      if (options?.replay !== false) {
        const replay = replayWithinWindow(session.events, lastSeq);
        if (replay.exceeded !== null) {
          sender.send(JSON.stringify(replay.exceeded));
          return;
        }
        for (const event of replay.events) {
          sender.send(JSON.stringify(event));
        }
      }
      session.listeners.add(sender);
    },

    replay(id, lastSeq) {
      return replayWithinWindow(take(id).events, lastSeq);
    },

    detach(id, sender) {
      const session = sessions.get(id);
      session?.listeners.delete(sender);
    },
  };
}
