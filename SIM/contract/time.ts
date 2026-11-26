declare const instantBrand: unique symbol;

/** Календарный момент прогона: целые минуты от t0. Это не нормо-час и не станко-час. */
export type SimInstant = number & { readonly [instantBrand]: 'SimInstant' };

export function instant(minutes: number): SimInstant {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error('Момент симуляции — целое число минут от начала прогона, не меньше нуля.');
  }
  return minutes as SimInstant;
}

export const SHIFT_MINUTES = 12 * 60;
export const SHIFTS_PER_DAY = 2;
/** Сутки садки: две смены по 12 часов. */
export const CHARGE_DAY_MINUTES = SHIFT_MINUTES * SHIFTS_PER_DAY;

export interface ShiftWindow {
  readonly index: number;
  readonly start: SimInstant;
  readonly end: SimInstant;
}

export function shiftWindow(index: number, horizonShifts: number): ShiftWindow {
  if (!Number.isInteger(index) || index < 0 || index >= horizonShifts) {
    throw new Error(`Смена ${index} вне горизонта ${horizonShifts}.`);
  }
  const start = index * SHIFT_MINUTES;
  return { index, start: instant(start), end: instant(start + SHIFT_MINUTES) };
}

/** Полуинтервал [start, end). Факт на границе конца принадлежит следующей смене. */
export function inShift(at: SimInstant, window: ShiftWindow): boolean {
  return at >= window.start && at < window.end;
}

export function nextShiftStart(at: SimInstant): SimInstant {
  const index = Math.floor(at / SHIFT_MINUTES);
  return instant((index + 1) * SHIFT_MINUTES);
}

export function recordingLagMinutes(trueTime: SimInstant, recordTime: SimInstant): number {
  return recordTime - trueTime;
}
