export const ROLES = [
  'commercial',
  'technologist',
  'normer',
  'pdo',
  'master',
  'worker',
  'otk',
  'archivist',
  'storekeeper',
] as const;

export type Role = (typeof ROLES)[number];

export type Flow = 'into-system' | 'into-plant';

/** Пропуск — отсутствие события. Эти ключи в теле события запрещены. */
export const BANNED_EVENT_KEYS = ['missed', 'skipped', 'пропущено'] as const;

export const EVENT_SPEC = {
  'order-registered': { author: 'commercial', flow: 'into-system', times: 'record' },
  'route-approved': { author: 'technologist', flow: 'into-system', times: 'record' },
  'norm-assigned': { author: 'normer', flow: 'into-system', times: 'record' },
  'design-doc-recorded': { author: 'archivist', flow: 'into-system', times: 'record' },
  assignment: { author: 'master', flow: 'into-system', times: 'both' },
  'master-close': { author: 'master', flow: 'into-system', times: 'both' },
  'worker-close': { author: 'worker', flow: 'into-system', times: 'both' },
  'quality-decision': { author: 'otk', flow: 'into-system', times: 'both' },
  'material-arrived': { author: 'storekeeper', flow: 'into-system', times: 'both' },
  'finished-goods-received': { author: 'storekeeper', flow: 'into-system', times: 'both' },
  'shipment-recorded': { author: 'storekeeper', flow: 'into-system', times: 'both' },
  'plan-issued': { author: 'pdo', flow: 'into-plant', times: 'issued' },
  'shift-task-issued': { author: 'pdo', flow: 'into-plant', times: 'issued' },
} as const;

export type EventTypeV1 = keyof typeof EVENT_SPEC;

interface EventCommon {
  readonly version: 1;
  readonly author: Role;
  readonly flow: Flow;
}

export interface OrderRegisteredV1 extends EventCommon {
  readonly type: 'order-registered';
  readonly orderId: string;
  readonly recordedAt: number;
}

export interface RouteApprovedV1 extends EventCommon {
  readonly type: 'route-approved';
  readonly orderId: string;
  readonly recordedAt: number;
}

export interface NormAssignedV1 extends EventCommon {
  readonly type: 'norm-assigned';
  readonly orderId: string;
  readonly operationId: string;
  readonly normHours: number;
  readonly recordedAt: number;
}

export interface DesignDocRecordedV1 extends EventCommon {
  readonly type: 'design-doc-recorded';
  readonly orderId: string;
  readonly recordedAt: number;
}

export interface AssignmentV1 extends EventCommon {
  readonly type: 'assignment';
  readonly operationId: string;
  readonly resourceId: string;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface MasterCloseV1 extends EventCommon {
  readonly type: 'master-close';
  readonly operationId: string;
  readonly piecesDone: number;
  readonly piecesScrap: number;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface WorkerCloseV1 extends EventCommon {
  readonly type: 'worker-close';
  readonly operationId: string;
  readonly piecesDone: number;
  readonly piecesScrap: number;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface QualityDecisionV1 extends EventCommon {
  readonly type: 'quality-decision';
  readonly operationId: string;
  readonly accepted: boolean;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface MaterialArrivedV1 extends EventCommon {
  readonly type: 'material-arrived';
  readonly orderId: string;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface FinishedGoodsReceivedV1 extends EventCommon {
  readonly type: 'finished-goods-received';
  readonly orderId: string;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface ShipmentRecordedV1 extends EventCommon {
  readonly type: 'shipment-recorded';
  readonly orderId: string;
  readonly trueTime: number;
  readonly recordTime: number;
}

export interface PlanIssuedV1 extends EventCommon {
  readonly type: 'plan-issued';
  readonly versionId: string;
  readonly issuedAt: number;
}

export interface ShiftTaskIssuedV1 extends EventCommon {
  readonly type: 'shift-task-issued';
  readonly snapshotId: string;
  readonly issuedAt: number;
}

export type ContractEventV1 =
  | OrderRegisteredV1
  | RouteApprovedV1
  | NormAssignedV1
  | DesignDocRecordedV1
  | AssignmentV1
  | MasterCloseV1
  | WorkerCloseV1
  | QualityDecisionV1
  | MaterialArrivedV1
  | FinishedGoodsReceivedV1
  | ShipmentRecordedV1
  | PlanIssuedV1
  | ShiftTaskIssuedV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Событие: поле «${key}» должно быть непустой строкой.`);
  }
  return value;
}

function requiredMinute(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Событие: поле «${key}» — целое число минут, не меньше нуля.`);
  }
  return value;
}

function requiredPieces(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Событие: поле «${key}» — целое число штук, не меньше нуля.`);
  }
  return value;
}

function assertNoBanned(raw: Record<string, unknown>): void {
  for (const key of BANNED_EVENT_KEYS) {
    if (key in raw) {
      throw new Error(`Поле «${key}» запрещено: пропуск выражается отсутствием события.`);
    }
  }
}

export function parseEventV1(raw: unknown): ContractEventV1 {
  if (!isRecord(raw)) {
    throw new Error('Событие версии 1 должно быть объектом.');
  }
  assertNoBanned(raw);
  if (raw['version'] !== 1) {
    throw new Error('parseEventV1 читает только версию 1.');
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !(type in EVENT_SPEC)) {
    throw new Error(`Неизвестный тип события версии 1: ${String(type)}.`);
  }
  const eventType = type as EventTypeV1;
  const spec = EVENT_SPEC[eventType];
  if (raw['author'] !== spec.author) {
    throw new Error(`Событие «${eventType}» пишет только роль «${spec.author}».`);
  }
  if (raw['flow'] !== spec.flow) {
    throw new Error(`Событие «${eventType}» имеет поток «${spec.flow}».`);
  }

  switch (eventType) {
    case 'order-registered':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        orderId: requiredString(raw, 'orderId'),
        recordedAt: requiredMinute(raw, 'recordedAt'),
      });
    case 'route-approved':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        orderId: requiredString(raw, 'orderId'),
        recordedAt: requiredMinute(raw, 'recordedAt'),
      });
    case 'norm-assigned': {
      const normHours = raw['normHours'];
      if (typeof normHours !== 'number' || !Number.isFinite(normHours) || normHours < 0) {
        throw new Error('Норма задаётся конечным числом нормо-часов, не меньше нуля.');
      }
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        orderId: requiredString(raw, 'orderId'),
        operationId: requiredString(raw, 'operationId'),
        normHours,
        recordedAt: requiredMinute(raw, 'recordedAt'),
      });
    }
    case 'design-doc-recorded':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        orderId: requiredString(raw, 'orderId'),
        recordedAt: requiredMinute(raw, 'recordedAt'),
      });
    case 'assignment':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        operationId: requiredString(raw, 'operationId'),
        resourceId: requiredString(raw, 'resourceId'),
        trueTime: requiredMinute(raw, 'trueTime'),
        recordTime: requiredMinute(raw, 'recordTime'),
      });
    case 'master-close':
    case 'worker-close':
      return closeEvent(eventType, raw);
    case 'quality-decision':
      if (typeof raw['accepted'] !== 'boolean') {
        throw new Error('Решение ОТК содержит признак accepted: true или false.');
      }
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        operationId: requiredString(raw, 'operationId'),
        accepted: raw['accepted'],
        trueTime: requiredMinute(raw, 'trueTime'),
        recordTime: requiredMinute(raw, 'recordTime'),
      });
    case 'material-arrived':
    case 'finished-goods-received':
    case 'shipment-recorded':
      return stockEvent(eventType, raw);
    case 'plan-issued':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        versionId: requiredString(raw, 'versionId'),
        issuedAt: requiredMinute(raw, 'issuedAt'),
      });
    case 'shift-task-issued':
      return Object.freeze({
        version: 1 as const,
        type: eventType,
        author: EVENT_SPEC[eventType].author,
        flow: EVENT_SPEC[eventType].flow,
        snapshotId: requiredString(raw, 'snapshotId'),
        issuedAt: requiredMinute(raw, 'issuedAt'),
      });
    default: {
      const neverType: never = eventType;
      throw new Error(`Неразобранный тип ${String(neverType)}.`);
    }
  }
}

function closeEvent(eventType: 'master-close' | 'worker-close', raw: Record<string, unknown>): MasterCloseV1 | WorkerCloseV1 {
  const piecesDone = requiredPieces(raw, 'piecesDone');
  const piecesScrap = requiredPieces(raw, 'piecesScrap');
  if (piecesScrap > piecesDone) {
    throw new Error('В отметке брак больше сделанного.');
  }
  const operationId = requiredString(raw, 'operationId');
  const trueTime = requiredMinute(raw, 'trueTime');
  const recordTime = requiredMinute(raw, 'recordTime');
  if (eventType === 'master-close') {
    return Object.freeze({
      version: 1 as const,
      type: eventType,
      author: EVENT_SPEC[eventType].author,
      flow: EVENT_SPEC[eventType].flow,
      operationId,
      piecesDone,
      piecesScrap,
      trueTime,
      recordTime,
    });
  }
  return Object.freeze({
    version: 1 as const,
    type: eventType,
    author: EVENT_SPEC[eventType].author,
    flow: EVENT_SPEC[eventType].flow,
    operationId,
    piecesDone,
    piecesScrap,
    trueTime,
    recordTime,
  });
}

function stockEvent(
  eventType: 'material-arrived' | 'finished-goods-received' | 'shipment-recorded',
  raw: Record<string, unknown>,
): MaterialArrivedV1 | FinishedGoodsReceivedV1 | ShipmentRecordedV1 {
  const orderId = requiredString(raw, 'orderId');
  const trueTime = requiredMinute(raw, 'trueTime');
  const recordTime = requiredMinute(raw, 'recordTime');
  if (eventType === 'material-arrived') {
    return Object.freeze({
      version: 1 as const,
      type: eventType,
      author: EVENT_SPEC[eventType].author,
      flow: EVENT_SPEC[eventType].flow,
      orderId,
      trueTime,
      recordTime,
    });
  }
  if (eventType === 'finished-goods-received') {
    return Object.freeze({
      version: 1 as const,
      type: eventType,
      author: EVENT_SPEC[eventType].author,
      flow: EVENT_SPEC[eventType].flow,
      orderId,
      trueTime,
      recordTime,
    });
  }
  return Object.freeze({
    version: 1 as const,
    type: eventType,
    author: EVENT_SPEC[eventType].author,
    flow: EVENT_SPEC[eventType].flow,
    orderId,
    trueTime,
    recordTime,
  });
}
