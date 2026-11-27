import { pieces } from '../contract/quantity.ts';
import type { Rng } from '../contract/rng.ts';
import { instant, SHIFT_MINUTES, type SimInstant } from '../contract/time.ts';
import { chargeSeats, completeOperation, receiveToWarehouse, recordDefect, startOperation } from './batch.ts';
import { occupationMinutes } from './occupation.ts';
import { areaDecidesFitness, controlScrapFor } from './stand.ts';
import {
  addDowntime,
  at,
  resourceDown,
  type PlantOperation,
  type PlantState,
} from './state.ts';

/** Модель: в документах наработки нет. 20 смен занятого времени станка. */
export const MACHINE_MTBF_BUSY_MINUTES = 20 * SHIFT_MINUTES;

/** Модель: после пересечения порога станок стоит одну смену. Текущая работа дозакрывается целиком. */
export const REPAIR_MINUTES = SHIFT_MINUTES;

export interface ShopStart {
  readonly operationId: string;
  readonly resourceId: string;
  readonly at: number;
}

export interface ShopCompletion {
  readonly operationId: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly resourceId: string | null;
  readonly at: number;
  /** Штуки этой порции, не накопительный итог. */
  readonly done: number;
  readonly scrap: number;
  readonly cumulativeDone: number;
  readonly cumulativeScrap: number;
  /** Порция, после которой операция закрыта и предыдущая больше ничего не пришлёт. */
  readonly final: boolean;
  readonly warehouse: boolean;
}

export interface ReadySnap {
  readonly index: number;
  readonly operationIds: readonly string[];
}

export interface FailureDraw {
  readonly resourceId: string;
  readonly busyMinute: number;
}

export interface ShopRun {
  readonly shop: PlantState;
  readonly starts: readonly ShopStart[];
  readonly completions: readonly ShopCompletion[];
  readonly readyAtShift: readonly ReadySnap[];
  readonly failureBusyMinute: readonly FailureDraw[];
}

/** Приоритет партии, действующий с момента решения. Ранг меньше — очередь раньше. */
export interface PriorityOrder {
  readonly batchId: string;
  readonly rank: number;
  /** Минута прогона, с которой ранг действует. Раньше этого момента приоритет прежний. */
  readonly appliedAt: number;
}

export interface ShopRunInput {
  readonly shop: PlantState;
  readonly dueByBatch: ReadonlyMap<string, number | null>;
  /** Генератор отказов станков. Контроль его не трогает. */
  readonly rng: Rng;
  /** Отдельная последовательность из того же seed. Только годность на контроле. */
  readonly controlRng: Rng;
  /** Помеха брака. Без неё контроль брак не назначает и генератор не расходует. */
  readonly controlEnabled: boolean;
  readonly horizonShifts: number;
  /** Решения о приоритете. Пустой список — очередь сортируется как до этого изменения. */
  readonly priority?: readonly PriorityOrder[];
}

interface Job {
  readonly operationId: string;
  readonly resourceId: string;
  readonly startedAt: number;
  readonly finishAt: number;
  /** Штуки этой порции. null — закрыть всё, что осталось к моменту finishAt. */
  readonly closePieces: number | null;
  /** false — середина операции, ресурс остаётся занят до finalAt. */
  readonly release: boolean;
  readonly finalAt: number;
}

function drawBusyMinute(rng: Rng, mean: number): number {
  const unit = rng();
  if (!(unit >= 0 && unit < 1)) {
    throw new Error('Генератор вернул число вне полуинтервала [0, 1).');
  }
  const span = Math.floor(-mean * Math.log(1 - unit));
  if (!Number.isInteger(span) || span < 0) {
    throw new Error('Момент отказа должен быть целым числом минут занятого времени.');
  }
  return span;
}

function byId(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Физический прогон цеха. Записи Системы не читает и не пишет.
 * Генератор отказов тратится только на поломки станков, в порядке маршрута.
 * Годность на контроле берётся из отдельного генератора и эту последовательность не сдвигает.
 */
export function runShop(input: ShopRunInput): ShopRun {
  if (input.shop.now !== 0) {
    throw new Error('Прогон цеха начинается с нулевой минуты.');
  }
  if (!Number.isInteger(input.horizonShifts) || input.horizonShifts <= 0) {
    throw new Error('Горизонт прогона — целое число смен больше нуля.');
  }
  const horizonEnd = input.horizonShifts * SHIFT_MINUTES;
  let shop = input.shop;
  const jobs: Job[] = [];
  const starts: ShopStart[] = [];
  const completions: ShopCompletion[] = [];
  const readyAtShift: ReadySnap[] = [];
  const seenShift = new Set<number>();

  const machines = shop.resources.filter((resource) => resource.kind === 'machines');
  const failureBusyMinute: FailureDraw[] = machines.map((resource) => ({
    resourceId: resource.id,
    busyMinute: drawBusyMinute(input.rng, MACHINE_MTBF_BUSY_MINUTES),
  }));
  const failureAt = new Map(failureBusyMinute.map((row) => [row.resourceId, row.busyMinute]));
  const busy = new Map<string, number>(machines.map((resource) => [resource.id, 0]));
  const repairOpened = new Set<string>();

  function requireOperation(id: string): PlantOperation {
    const found = shop.operations.find((item) => item.id === id);
    if (!found) {
      throw new Error(`Операция «${id}» не найдена.`);
    }
    return found;
  }

  function dueOf(batchId: string): number | null {
    const due = input.dueByBatch.get(batchId);
    return due === undefined ? null : due;
  }

  /**
   * Ранг, действующий на этот момент. До appliedAt решение не видно.
   * Повтор по той же партии перекрывает прежний ранг с нового момента:
   * берётся запись с большим appliedAt, при равном моменте — более поздняя в списке.
   */
  function rankOf(batchId: string, now: number): number | null {
    let best: PriorityOrder | null = null;
    for (const row of input.priority ?? []) {
      if (row.batchId !== batchId || row.appliedAt > now) {
        continue;
      }
      if (best === null || row.appliedAt >= best.appliedAt) {
        best = row;
      }
    }
    return best === null ? null : best.rank;
  }

  function compareReady(left: PlantOperation, right: PlantOperation, now: number): number {
    const leftRank = rankOf(left.batchId, now);
    const rightRank = rankOf(right.batchId, now);
    if (leftRank !== null || rightRank !== null) {
      const leftValue = leftRank ?? Number.MAX_SAFE_INTEGER;
      const rightValue = rightRank ?? Number.MAX_SAFE_INTEGER;
      if (leftValue !== rightValue) {
        return leftValue - rightValue;
      }
    }
    const leftDue = dueOf(left.batchId);
    const rightDue = dueOf(right.batchId);
    if ((leftDue === null) !== (rightDue === null)) {
      return leftDue === null ? 1 : -1;
    }
    if (leftDue !== null && rightDue !== null && leftDue !== rightDue) {
      return leftDue - rightDue;
    }
    if (left.batchId !== right.batchId) {
      return byId(left.batchId, right.batchId);
    }
    return left.sequence - right.sequence;
  }

  function snap(now: number): void {
    if (now % SHIFT_MINUTES !== 0) {
      return;
    }
    const index = now / SHIFT_MINUTES;
    if (!Number.isInteger(index) || index < 0 || index >= input.horizonShifts || seenShift.has(index)) {
      return;
    }
    seenShift.add(index);
    const operationIds = shop.operations
      .filter((item) => item.status === 'ready')
      .map((item) => item.id)
      .sort(byId);
    readyAtShift.push({ index, operationIds });
  }

  function controlScrap(operation: PlantOperation, portion: number, release: boolean): number {
    if (!input.controlEnabled || !areaDecidesFitness(operation.areaId)) {
      return 0;
    }
    const draw = input.controlRng();
    if (!release) {
      return 0;
    }
    return controlScrapFor(draw, portion);
  }

  function completeDue(now: number): void {
    const due = jobs
      .filter((job) => job.finishAt === now)
      .sort((left, right) => byId(left.operationId, right.operationId));
    for (const job of due) {
      const current = requireOperation(job.operationId);
      const remaining = current.planned - current.done;
      const portion = job.closePieces === null ? remaining : job.closePieces;
      if (!Number.isInteger(portion) || portion <= 0 || portion > remaining) {
        throw new Error(`Порция операции «${job.operationId}» вне оставшегося количества.`);
      }
      const release = job.release || portion === remaining;
      const scrap = controlScrap(current, portion, release);
      if (scrap > portion) {
        throw new Error(`Брак операции «${job.operationId}» больше порции.`);
      }
      shop = completeOperation(shop, job.operationId, pieces(portion), pieces(scrap));
      const index = jobs.findIndex((item) => item.operationId === job.operationId && item.finishAt === job.finishAt);
      if (index < 0) {
        throw new Error(`Работа «${job.operationId}» уже снята.`);
      }
      jobs.splice(index, 1);
      const updated = requireOperation(job.operationId);
      const final = updated.status === 'done';
      completions.push({
        operationId: job.operationId,
        batchId: updated.batchId,
        areaId: updated.areaId,
        resourceId: job.resourceId,
        at: now,
        done: portion,
        scrap,
        cumulativeDone: updated.done,
        cumulativeScrap: updated.scrap,
        final,
        warehouse: false,
      });
      if (final && scrap > 0 && areaDecidesFitness(updated.areaId)) {
        shop = recordDefect(shop, updated.batchId, `${updated.batchId}-defect-${updated.sequence}`, pieces(scrap));
      }
      if (updated.status === 'running') {
        if (release || job.finalAt <= now) {
          throw new Error(`Операция «${job.operationId}» не закрылась и не оставила хвост.`);
        }
        jobs.push({
          operationId: job.operationId,
          resourceId: job.resourceId,
          startedAt: job.startedAt,
          finishAt: job.finalAt,
          closePieces: null,
          release: true,
          finalAt: job.finalAt,
        });
        continue;
      }
      const resource = shop.resources.find((item) => item.id === job.resourceId);
      if (resource?.kind !== 'machines') {
        continue;
      }
      const spent = (busy.get(job.resourceId) ?? 0) + (job.finalAt - job.startedAt);
      busy.set(job.resourceId, spent);
      const limit = failureAt.get(job.resourceId);
      if (limit === undefined || repairOpened.has(job.resourceId) || spent < limit) {
        continue;
      }
      repairOpened.add(job.resourceId);
      shop = addDowntime(shop, {
        id: `repair-${job.resourceId}-${now}`,
        resourceId: job.resourceId,
        from: instant(now),
        until: instant(now + REPAIR_MINUTES),
        reason: 'breakdown',
      });
    }
  }

  function receiveWarehouses(now: number): void {
    let guard = 0;
    for (;;) {
      const waiting = shop.operations
        .filter((item) => {
          if (item.status !== 'ready') {
            return false;
          }
          const area = shop.areas.find((candidate) => candidate.id === item.areaId);
          return area?.role.role === 'warehouse';
        })
        .sort((left, right) => byId(left.id, right.id));
      const next = waiting[0];
      if (!next) {
        return;
      }
      const portion = next.planned - next.done;
      const upstream = shop.operations.find(
        (item) => item.batchId === next.batchId && item.sequence === next.sequence - 1,
      );
      shop = receiveToWarehouse(shop, next.id);
      const accepted = requireOperation(next.id);
      completions.push({
        operationId: next.id,
        batchId: next.batchId,
        areaId: next.areaId,
        resourceId: null,
        at: now,
        done: portion,
        scrap: 0,
        cumulativeDone: accepted.done,
        cumulativeScrap: accepted.scrap,
        final: upstream === undefined || upstream.status === 'done',
        warehouse: true,
      });
      guard += 1;
      if (guard > shop.operations.length) {
        throw new Error('Приёмка на склад зациклилась.');
      }
    }
  }

  function place(operation: PlantOperation, resourceId: string, now: number, finishAt: number, closePieces: number | null, release: boolean, finalAt: number): void {
    shop = startOperation(shop, operation.id, resourceId);
    jobs.push({
      operationId: operation.id,
      resourceId,
      startedAt: now,
      finishAt,
      closePieces,
      release,
      finalAt,
    });
    starts.push({ operationId: operation.id, resourceId, at: now });
  }

  function startResources(now: number): void {
    for (const resource of shop.resources) {
      if (resourceDown(shop, resource.id, instant(now))) {
        continue;
      }
      const candidates = shop.operations
        .filter((item) => item.status === 'ready' && item.areaId === resource.areaId)
        .sort((left, right) => compareReady(left, right, now));
      if (resource.chargePieces === null) {
        if (shop.operations.some((item) => item.resourceId === resource.id && item.status === 'running')) {
          continue;
        }
        for (const candidate of candidates) {
          const duration = occupationMinutes(candidate.effort);
          if (duration <= 0) {
            throw new Error(`У операции «${candidate.id}» нет длительности.`);
          }
          if (resource.kind === 'personnel') {
            const shiftEnd = (Math.floor(now / SHIFT_MINUTES) + 1) * SHIFT_MINUTES;
            if (now + duration > shiftEnd) {
              continue;
            }
          }
          if (resource.kind === 'cooperation') {
            throw new Error('Кооперации на маршруте стенда нет.');
          }
          const halfPieces = Math.floor(candidate.planned / 2);
          const halfTime = Math.floor(duration / 2);
          if (halfPieces >= 1 && halfPieces < candidate.planned && halfTime >= 1 && halfTime < duration) {
            place(candidate, resource.id, now, now + halfTime, halfPieces, false, now + duration);
          } else {
            place(candidate, resource.id, now, now + duration, null, true, now + duration);
          }
          break;
        }
        continue;
      }
      let occupied = shop.operations
        .filter((item) => item.resourceId === resource.id && item.status === 'running')
        .reduce((sum, item) => sum + chargeSeats(shop, item.id), 0);
      let chargeEnd: number | null = null;
      for (const job of jobs) {
        if (job.resourceId !== resource.id) {
          continue;
        }
        if (chargeEnd === null || job.finalAt > chargeEnd) {
          chargeEnd = job.finalAt;
        }
      }
      for (const candidate of candidates) {
        const seats = chargeSeats(shop, candidate.id);
        if (occupied + seats > resource.chargePieces) {
          break;
        }
        const duration = occupationMinutes(candidate.effort);
        if (duration <= 0) {
          throw new Error(`У операции «${candidate.id}» нет длительности.`);
        }
        const finish = chargeEnd ?? now + duration;
        place(candidate, resource.id, now, finish, null, true, finish);
        if (chargeEnd === null) {
          chargeEnd = finish;
        }
        occupied += seats;
      }
    }
  }

  function tick(now: number, allowStart: boolean): void {
    shop = at(shop, instant(now));
    completeDue(now);
    receiveWarehouses(now);
    snap(now);
    if (allowStart) {
      startResources(now);
    }
  }

  tick(0, true);
  let now = 0;
  let steps = 0;
  while (now < horizonEnd) {
    let next = horizonEnd;
    for (const job of jobs) {
      if (job.finishAt > now && job.finishAt < next) {
        next = job.finishAt;
      }
    }
    for (const downtime of shop.downtimes) {
      if (downtime.until !== null && downtime.until > now && downtime.until < next) {
        next = downtime.until;
      }
    }
    const boundary = (Math.floor(now / SHIFT_MINUTES) + 1) * SHIFT_MINUTES;
    if (boundary > now && boundary < next) {
      next = boundary;
    }
    if (next <= now) {
      throw new Error('Часы цеха не продвинулись.');
    }
    now = next;
    steps += 1;
    if (steps > horizonEnd) {
      throw new Error('Слишком много шагов прогона.');
    }
    tick(now, now < horizonEnd);
  }

  return { shop, starts, completions, readyAtShift, failureBusyMinute };
}

export function shiftEnd(at: SimInstant): number {
  return (Math.floor(at / SHIFT_MINUTES) + 1) * SHIFT_MINUTES;
}
