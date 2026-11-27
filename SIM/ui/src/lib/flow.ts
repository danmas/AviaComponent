/**
 * Схема потока: участки в порядке маршрута, связи между ними и узкое место.
 *
 * Число на связи — операции участка-источника в статусе «ждёт». Это же число
 * показано в очереди участка: второго правила подсчёта нет.
 */
import type { ShopResponse } from '../../../api-client/types.ts';

type Shop = ShopResponse['reality'];
type ShopArea = Shop['areas'][number];
type ShopOperation = Shop['operations'][number];

export interface FlowNode {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly waiting: readonly ShopOperation[];
  readonly running: readonly ShopOperation[];
  readonly isBottleneck: boolean;
}

export interface FlowLink {
  readonly from: string;
  readonly to: string;
  /** Сколько операций источника готово к запуску — то же, что очередь участка. */
  readonly waitingCount: number;
}

export interface Flow {
  readonly nodes: readonly FlowNode[];
  readonly links: readonly FlowLink[];
  readonly bottleneckId: string | null;
}

/** Минуты ожидания операции: от готовности до старта или до текущей минуты. */
export function waitMinutes(operation: ShopOperation, now: number): number | null {
  if (operation.readyAt === null) {
    return null;
  }
  const end = operation.startedAt ?? (operation.status === 'ready' ? now : null);
  if (end === null) {
    return null;
  }
  return end - operation.readyAt < 0 ? 0 : end - operation.readyAt;
}

interface AreaLoad {
  readonly id: string;
  readonly order: number;
  readonly sumMinutes: number;
  readonly waitingCount: number;
}

/**
 * Узкое место: наибольшая сумма ожидания, при равенстве — больше ожидающих,
 * при полном равенстве — раньше в маршруте. Три ступени нужны, чтобы выбор
 * не зависел от порядка перебора.
 */
export function bottleneckOf(loads: readonly AreaLoad[]): string | null {
  const waitingAreas = loads.filter((load) => load.waitingCount > 0);
  if (waitingAreas.length === 0) {
    return null;
  }
  const best = [...waitingAreas].sort((left, right) => {
    if (right.sumMinutes !== left.sumMinutes) {
      return right.sumMinutes - left.sumMinutes;
    }
    if (right.waitingCount !== left.waitingCount) {
      return right.waitingCount - left.waitingCount;
    }
    return left.order - right.order;
  })[0];
  return best?.id ?? null;
}

export function flowOf(shop: Shop): Flow {
  const loads: AreaLoad[] = shop.areas.map((area: ShopArea, order: number) => {
    const waiting = shop.operations.filter(
      (operation: ShopOperation) => operation.areaId === area.id && operation.status === 'ready',
    );
    const sumMinutes = waiting.reduce((sum: number, operation: ShopOperation) => {
      const minutes = waitMinutes(operation, shop.now);
      return sum + (minutes ?? 0);
    }, 0);
    return { id: area.id, order, sumMinutes, waitingCount: waiting.length };
  });

  const bottleneckId = bottleneckOf(loads);

  const nodes: FlowNode[] = shop.areas.map((area: ShopArea, order: number) => ({
    id: area.id,
    name: area.name,
    order,
    waiting: shop.operations.filter(
      (operation: ShopOperation) => operation.areaId === area.id && operation.status === 'ready',
    ),
    running: shop.operations.filter(
      (operation: ShopOperation) => operation.areaId === area.id && operation.status === 'running',
    ),
    isBottleneck: area.id === bottleneckId,
  }));

  const links: FlowLink[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const node = nodes[index];
    const next = nodes[index + 1];
    if (node === undefined || next === undefined) {
      continue;
    }
    links.push({ from: node.id, to: next.id, waitingCount: node.waiting.length });
  }

  return { nodes, links, bottleneckId };
}

/** Часы с одним знаком после запятой. */
export function hoursOf(minutes: number): number {
  return Math.round(minutes / 6) / 10;
}
