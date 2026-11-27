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
  /** Минута, на которой заказ регистрируется. Не выводится из других полей. */
  readonly arrivesAt: number;
  /**
   * Принят в момент поступления без отдельного решения.
   * Задаётся каталогом. Из `arrivesAt === 0` не следует.
   */
  readonly acceptedByDefault: boolean;
}

const BASE_ORDERS: readonly StandOrder[] = [
  {
    id: 'order-1',
    contractDue: 9 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-1', 'batch-2'],
    arrivesAt: 0,
    acceptedByDefault: true,
  },
  {
    id: 'order-2',
    contractDue: 11 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-3'],
    arrivesAt: 0,
    acceptedByDefault: true,
  },
  {
    id: 'order-3',
    contractDue: 8 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-4'],
    arrivesAt: 0,
    acceptedByDefault: true,
  },
  {
    id: 'order-4',
    contractDue: 10 * SHIFT_MINUTES,
    material: true,
    designDoc: true,
    norms: true,
    batchIds: ['batch-5', 'batch-6'],
    arrivesAt: 0,
    acceptedByDefault: true,
  },
];

/** Помеха incoming: смена 4, минута 2880. Срок — две смены от поступления. */
export const INCOMING_ARRIVAL = 4 * SHIFT_MINUTES;
export const INCOMING_DUE = INCOMING_ARRIVAL + 2 * SHIFT_MINUTES;

const INCOMING_ORDER: StandOrder = {
  id: 'order-5',
  contractDue: INCOMING_DUE,
  material: true,
  designDoc: true,
  norms: true,
  batchIds: ['batch-7'],
  arrivesAt: INCOMING_ARRIVAL,
  acceptedByDefault: false,
};

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
  }).concat(overlay === 'incoming' ? [INCOMING_ORDER] : []);
}
