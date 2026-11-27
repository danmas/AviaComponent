/**
 * Перевод состояния цеха в то, что видно на экране.
 *
 * Ничего не считает заново: берёт срез `shop` и раскладывает по участкам.
 * Единственное вычисление — разница двух срезов для режима «движение».
 */
import type { ShopResponse } from '../../../api-client/types.ts';

export type OperationStatus = 'not-ready' | 'ready' | 'running' | 'done';

type Shop = ShopResponse['reality'];
type ShopArea = Shop['areas'][number];
type ShopResource = Shop['resources'][number];
type ShopBatch = Shop['batches'][number];
type ShopOperation = Shop['operations'][number];
type ShopDowntime = Shop['downtimes'][number];

export interface AreaCard {
  readonly id: string;
  readonly name: string;
  readonly kind: 'processing' | 'warehouse';
  readonly resources: readonly ShopResource[];
  readonly running: readonly ShopOperation[];
  readonly waiting: readonly ShopOperation[];
  readonly finished: readonly ShopOperation[];
  readonly down: readonly ShopDowntime[];
  /** Свободен: нет ни работающих, ни ожидающих. */
  readonly idle: boolean;
}

export interface OperationView {
  readonly operation: ShopOperation;
  readonly batch: ShopBatch | undefined;
  readonly areaName: string;
}

/** Участки в порядке маршрута, с ресурсами, работой, ожиданием и простоями. */
export function areasOf(shop: Shop): readonly AreaCard[] {
  return shop.areas.map((area: ShopArea) => {
    const operations = shop.operations.filter((operation: ShopOperation) => operation.areaId === area.id);
    const resources = shop.resources.filter((resource: ShopResource) => resource.areaId === area.id);
    const running = operations.filter((operation: ShopOperation) => operation.status === 'running');
    const waiting = operations.filter((operation: ShopOperation) => operation.status === 'ready');
    const finished = operations.filter((operation: ShopOperation) => operation.status === 'done');
    const down = shop.downtimes.filter((downtime: ShopDowntime) =>
      resources.some((resource: ShopResource) => resource.id === downtime.resourceId));
    return {
      id: area.id,
      name: area.name,
      kind: area.role.role === 'warehouse' ? 'warehouse' : 'processing',
      resources,
      running,
      waiting,
      finished,
      down,
      idle: running.length === 0 && waiting.length === 0,
    };
  });
}

/** Партии в порядке первого появления на маршруте. */
export function batchesOf(shop: Shop): readonly ShopBatch[] {
  return shop.batches;
}

/**
 * Отметка партии, появившейся после старта. Стартовая (минута 0) не помечается:
 * пустая строка, а не «новая · 0 мин».
 */
export function arrivalText(batch: { readonly appearedAt: number }): string {
  if (batch.appearedAt <= 0) {
    return '';
  }
  return `новая · ${batch.appearedAt} мин`;
}

export function operationView(shop: Shop, operation: ShopOperation): OperationView {
  const batch = shop.batches.find((item: ShopBatch) => item.id === operation.batchId);
  const area = shop.areas.find((item: ShopArea) => item.id === operation.areaId);
  return { operation, batch, areaName: area?.name ?? operation.areaId };
}

/** Шаг маршрута партии: от первой операции до последней. */
export interface BatchTrack {
  readonly batch: ShopBatch;
  readonly steps: readonly OperationView[];
  /** Операция, на которой партия стоит сейчас, либо null, если партия прошла маршрут. */
  readonly current: OperationView | null;
  readonly doneCount: number;
  readonly totalCount: number;
}

export function tracksOf(shop: Shop): readonly BatchTrack[] {
  return shop.batches.map((batch: ShopBatch) => {
    const steps = shop.operations
      .filter((operation: ShopOperation) => operation.batchId === batch.id)
      .sort((left: ShopOperation, right: ShopOperation) => left.sequence - right.sequence)
      .map((operation: ShopOperation) => operationView(shop, operation));
    const current = steps.find((step) => step.operation.status !== 'done') ?? null;
    return {
      batch,
      steps,
      current,
      doneCount: steps.filter((step) => step.operation.status === 'done').length,
      totalCount: steps.length,
    };
  });
}

export interface OperationChange {
  readonly operationId: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly fromStatus: OperationStatus;
  readonly toStatus: OperationStatus;
  readonly fromDone: number;
  readonly toDone: number;
  readonly resourceId: string | null;
}

/**
 * Разница двух срезов цеха по операциям. Только факты: что сменило статус,
 * что сдвинуло счёт и на каком ресурсе. Ничего не досчитывается.
 */
export function movementBetween(before: Shop, after: Shop): readonly OperationChange[] {
  const changes: OperationChange[] = [];
  for (const earlier of before.operations) {
    const later = after.operations.find((operation: ShopOperation) => operation.id === earlier.id);
    if (later === undefined) {
      continue;
    }
    const statusMoved = later.status !== earlier.status;
    const countMoved = later.done !== earlier.done;
    const resourceMoved = (later.resourceId ?? null) !== (earlier.resourceId ?? null);
    if (!statusMoved && !countMoved && !resourceMoved) {
      continue;
    }
    changes.push({
      operationId: earlier.id,
      batchId: earlier.batchId,
      areaId: earlier.areaId,
      fromStatus: earlier.status as OperationStatus,
      toStatus: later.status as OperationStatus,
      fromDone: earlier.done,
      toDone: later.done,
      resourceId: later.resourceId ?? null,
    });
  }
  return changes;
}

/** Строка садки из среза: занятые штуки, ёмкость и какие партии сидят. */
export function chargeText(
  chargePieces: number | null,
  running: readonly { readonly planned: number; readonly batchId: string }[],
): string | null {
  if (chargePieces === null) {
    return null;
  }
  const occupied = running.reduce((sum, operation) => sum + operation.planned, 0);
  const free = chargePieces - occupied;
  const names = running.map((operation) => operation.batchId).join(', ');
  const room = free > 0 ? ` · свободно ${free}` : '';
  const who = names === '' ? '' : ` · ${names}`;
  return `занято ${occupied} из ${chargePieces}${room}${who}`;
}

/** Сделанное и годное отдельно от плана. */
export function progressText(done: number, planned: number, scrap: number): string {
  return `сделано ${done} из ${planned}, годное ${done - scrap}`;
}

/** Сколько операций в каждом статусе — для счётчика на экране. */
export function statusCounts(shop: Shop): Record<OperationStatus, number> {
  const counts: Record<OperationStatus, number> = { 'not-ready': 0, ready: 0, running: 0, done: 0 };
  for (const operation of shop.operations) {
    counts[operation.status as OperationStatus] += 1;
  }
  return counts;
}
