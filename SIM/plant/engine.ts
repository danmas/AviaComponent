import { pieces } from '../contract/quantity.ts';
import type { Rng } from '../contract/rng.ts';
import { instant, SHIFT_MINUTES, type SimInstant } from '../contract/time.ts';
import { completeOperation, receiveToWarehouse, startOperation } from './batch.ts';
import { occupationMinutes } from './occupation.ts';
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
  readonly done: number;
  readonly scrap: number;
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

export interface ShopRunInput {
  readonly shop: PlantState;
  readonly dueByBatch: ReadonlyMap<string, number | null>;
  readonly scrapByOperation: ReadonlyMap<string, number>;
  readonly rng: Rng;
  readonly horizonShifts: number;
}

interface Job {
  readonly operationId: string;
  readonly resourceId: string;
  readonly startedAt: number;
  readonly finishAt: number;
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
 * Генератор здесь тратится только на отказы станков, в порядке маршрута.
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

  function compareReady(left: PlantOperation, right: PlantOperation): number {
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

  function completeDue(now: number): void {
    const due = jobs
      .filter((job) => job.finishAt === now)
      .sort((left, right) => byId(left.operationId, right.operationId));
    for (const job of due) {
      const current = requireOperation(job.operationId);
      const scrap = input.scrapByOperation.get(job.operationId) ?? 0;
      if (!Number.isInteger(scrap) || scrap < 0 || scrap > current.planned) {
        throw new Error(`Брак операции «${job.operationId}» вне планового количества.`);
      }
      shop = completeOperation(shop, job.operationId, current.planned, pieces(scrap));
      const index = jobs.findIndex((item) => item.operationId === job.operationId);
      if (index < 0) {
        throw new Error(`Работа «${job.operationId}» уже снята.`);
      }
      jobs.splice(index, 1);
      completions.push({
        operationId: job.operationId,
        batchId: current.batchId,
        areaId: current.areaId,
        resourceId: job.resourceId,
        at: now,
        done: current.planned,
        scrap,
        warehouse: false,
      });
      const resource = shop.resources.find((item) => item.id === job.resourceId);
      if (resource?.kind !== 'machines') {
        continue;
      }
      const spent = (busy.get(job.resourceId) ?? 0) + (job.finishAt - job.startedAt);
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
      const planned = next.planned;
      shop = receiveToWarehouse(shop, next.id);
      completions.push({
        operationId: next.id,
        batchId: next.batchId,
        areaId: next.areaId,
        resourceId: null,
        at: now,
        done: planned,
        scrap: 0,
        warehouse: true,
      });
      guard += 1;
      if (guard > shop.operations.length) {
        throw new Error('Приёмка на склад зациклилась.');
      }
    }
  }

  function startResources(now: number): void {
    for (const resource of shop.resources) {
      if (resourceDown(shop, resource.id, instant(now))) {
        continue;
      }
      if (shop.operations.some((item) => item.resourceId === resource.id && item.status === 'running')) {
        continue;
      }
      const candidates = shop.operations
        .filter((item) => item.status === 'ready' && item.areaId === resource.areaId)
        .sort(compareReady);
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
        shop = startOperation(shop, candidate.id, resource.id);
        jobs.push({
          operationId: candidate.id,
          resourceId: resource.id,
          startedAt: now,
          finishAt: now + duration,
        });
        starts.push({ operationId: candidate.id, resourceId: resource.id, at: now });
        break;
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
