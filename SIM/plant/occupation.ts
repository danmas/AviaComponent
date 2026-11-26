import type { AnyQuantity, UnitKind } from '../contract/units.ts';

/** Минуты, которые ресурс занят. Это не нормо-час и не перевод единиц показателя. */
export interface OccupationBasis {
  readonly id: string;
  readonly kind: UnitKind;
  readonly minutesPerUnit: number;
  readonly sourceNote: string;
}

/**
 * Основания зафиксированы до прогона.
 * Нормо-часа здесь нет: в минуты цеха его переводить нечем.
 */
export const OCCUPATION_BASES: readonly OccupationBasis[] = [
  {
    id: 'model-machine-hour-minutes',
    kind: 'machine-hour',
    minutesPerUnit: 60,
    sourceNote: 'Модель: один станко-час занимает станок 60 минут. Это не перевод в нормо-часы.',
  },
  {
    id: 'model-person-hour-minutes',
    kind: 'person-hour',
    minutesPerUnit: 60,
    sourceNote: 'Модель: один человеко-час занимает человека 60 минут. Это не перевод в нормо-часы.',
  },
  {
    id: 'stand-charge-day-minutes',
    kind: 'charge-day',
    minutesPerUnit: 1440,
    sourceNote: 'Сутки садки длятся две смены по 12 часов. Правило стенда, не паспорт печи.',
  },
];

export function occupationMinutes(effort: AnyQuantity | null): number {
  if (effort === null) {
    return 0;
  }
  const basis = OCCUPATION_BASES.find((item) => item.kind === effort.kind);
  if (!basis) {
    throw new Error(`Для единицы «${effort.kind}» нет основания перевода в минуты занятия.`);
  }
  if (!Number.isFinite(effort.amount) || effort.amount < 0) {
    throw new Error('Длительность операции должна быть конечной и не меньше нуля.');
  }
  const minutes = effort.amount * basis.minutesPerUnit;
  if (!Number.isInteger(minutes)) {
    throw new Error('Минуты занятия должны быть целым числом.');
  }
  return minutes;
}
