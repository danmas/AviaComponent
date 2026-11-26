/**
 * Пропуски запуска в человеческие причины. Единственное место перевода:
 * экран не собирает текст причины сам, иначе две надписи разойдутся.
 */
export const MISSING_TEXT = {
  material: 'нет материала',
  kd: 'нет конструкторской документации',
  previous: 'не закончена предыдущая операция',
} as const;

export type MissingGate = keyof typeof MISSING_TEXT;

export function isMissingGate(value: string): value is MissingGate {
  return value === 'material' || value === 'kd' || value === 'previous';
}

/** Причины пропуска по порядку маршрута: материал, КД, предыдущая операция. */
export function missingReasons(missing: readonly string[]): readonly string[] {
  const order: readonly MissingGate[] = ['material', 'kd', 'previous'];
  return order.filter((gate) => missing.includes(gate)).map((gate) => MISSING_TEXT[gate]);
}

/** Одна строка для экрана: «нет материала; нет КД». Пусто — пустая строка. */
export function missingLine(missing: readonly string[]): string {
  return missingReasons(missing).join('; ');
}

export const DOWNTIME_TEXT = {
  'no-material': 'нет материала',
  'no-task': 'нет задания',
  breakdown: 'поломка',
} as const;

export type DowntimeReason = keyof typeof DOWNTIME_TEXT;

export function downtimeText(reason: string): string {
  return reason === 'no-material' || reason === 'no-task' || reason === 'breakdown'
    ? DOWNTIME_TEXT[reason]
    : reason;
}

export const STATUS_TEXT = {
  'not-ready': 'не готова',
  ready: 'ждёт',
  running: 'в работе',
  done: 'закрыта',
} as const;
