import type { Pieces } from '../contract/quantity.ts';
import type { SimInstant } from '../contract/time.ts';
import type { AnyQuantity, Quantity } from '../contract/units.ts';

export type OrderStatus = 'draft' | 'dse' | 'in-production' | 'archive';

export interface OrderRecord {
  readonly id: string;
  readonly status: OrderStatus;
  /** Договорная дата. Пусто, если коммерсант её не внёс. */
  readonly contractDue: SimInstant | null;
}

/** Норма нормировщика. operationId = null — норма на всю заявку. */
export interface NormRecord {
  readonly orderId: string;
  readonly operationId: string | null;
  readonly norm: Quantity<'norm-hour'>;
}

/** Отметка мастера или рабочего. Время записи и истинное время не совпадают по построению. */
export interface FactRecord {
  readonly id: string;
  readonly orderId: string;
  readonly operationId: string;
  readonly author: 'master' | 'worker';
  readonly trueTime: SimInstant;
  readonly recordTime: SimInstant;
}

export interface AreaLoadRecord {
  readonly areaId: string;
  readonly areaName: string;
  readonly capacity: AnyQuantity;
  readonly plan: AnyQuantity;
  readonly queue: AnyQuantity;
}

export interface PlanDateRecord {
  readonly orderId: string;
  readonly versionId: string;
  readonly createdAt: SimInstant;
  readonly calculatedDue: SimInstant | null;
}

/** Четыре блока сопроводительной карты. Итоги — запись, не состояние цеха. */
export interface RouteCardOperation {
  readonly operationId: string;
  readonly technology: string | null;
  readonly production: string | null;
  readonly control: string | null;
  readonly totals: { readonly done: Pieces; readonly scrap: Pieces } | null;
}

export interface SystemRecords {
  readonly orders: readonly OrderRecord[];
  readonly norms: readonly NormRecord[];
  readonly facts: readonly FactRecord[];
  readonly areaLoads: readonly AreaLoadRecord[];
  readonly planDates: readonly PlanDateRecord[];
  readonly cards: readonly RouteCardOperation[];
}

export function emptyRecords(): SystemRecords {
  return { orders: [], norms: [], facts: [], areaLoads: [], planDates: [], cards: [] };
}
