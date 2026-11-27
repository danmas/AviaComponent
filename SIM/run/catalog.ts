import { SHIFT_MINUTES } from '../contract/time.ts';
import type { LevelName, OverlayName } from './levels.ts';

/** Штук в партии. Садка печи — 8 штук, две партии садятся вместе. */
export const BATCH_PIECES = 4;

export const URGENT_DUE_MINUTE = SHIFT_MINUTES;
export const BREAKDOWN_RESOURCE = 'area-cnc-turn-1';
export const BREAKDOWN_UNTIL = SHIFT_MINUTES;

export interface StandOrder {
  readonly id: string;
  readonly contractDue: number | null;
  readonly material: boolean;
  readonly designDoc: boolean;
  readonly norms: boolean;
  readonly batchIds: readonly string[];
}

const BASE_ORDERS: readonly StandOrder[] = [
  {
    id: 'order-1',
    contractDue: 9 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-1', 'batch-2'],
  },
  {
    id: 'order-2',
    contractDue: 11 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-3'],
  },
  {
    id: 'order-3',
    contractDue: 8 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-4'],
  },
  {
    id: 'order-4',
    contractDue: 10 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-5', 'batch-6'],
  },
];

/** Уровень и помеха возвращают новый каталог. Базовая таблица не меняется. */
export function ordersFor(level: LevelName, overlay: OverlayName): readonly StandOrder[] {
  return BASE_ORDERS.map((order) => {
    let next = order;
    if (level === 'empty' && order.id === 'order-3') {
      next = { ...next, contractDue: null, norms: false };
    }
    if (level === 'empty' && order.id === 'order-4') {
      next = { ...next, material: false };
    }
    if (overlay === 'urgent' && next.id === 'order-4') {
      next = { ...next, contractDue: URGENT_DUE_MINUTE };
    }
    return next;
  });
}
