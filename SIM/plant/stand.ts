import { quantity, type AnyQuantity } from '../contract/units.ts';

export type Evidence = 'confirmed' | 'limitation' | 'hypothesis' | 'model';

export type ResourceKind = 'machines' | 'furnaces' | 'personnel' | 'cooperation';

export type Schedule = 'queue' | 'charge-day' | 'shift' | 'external-lead';

export type AreaRole =
  | { readonly role: 'processing'; readonly resourceKind: ResourceKind; readonly schedule: Schedule }
  | { readonly role: 'warehouse' };

export interface RouteStep {
  readonly areaId: string;
  readonly areaName: string;
  readonly role: AreaRole;
  /** Загрузка ресурса на одну операцию стенда. У склада нет. */
  readonly effort: AnyQuantity | null;
  /** Участок сам решает годность. Брак возникает здесь, а не константой на токарной. */
  readonly decidesFitness: boolean;
  readonly evidence: Evidence;
  readonly evidenceNote: string;
}

/**
 * Ёмкости стенда. Числа модельные: живой завод в стенд не копируется.
 * Садка — 8 штук: две партии по 4 садятся вместе. Один ресурс на участок.
 * Это не паспорт цеха. Сутки садки по длительности не менялись.
 */
export const PLANT_STAND = {
  furnaceChargePieces: 8,
  resourcesPerArea: 1,
} as const;

/**
 * Брак на контроле — вероятность, что партия получит брак, и сколько штук.
 *
 * Правило задано двумя числами стенда, чтобы его можно было прочитать одной
 * строкой и не зависеть от размера партии:
 *   вероятность — доля партий, на которых контроль что-то находит;
 *   штук — сколько штук бракуется, если контроль сработал.
 *
 * Вероятность берётся из отдельного генератора контроля, поэтому брак разный
 * на разных seed и не сдвигает последовательность для занятости станков.
 */
export const CONTROL_SCRAP_CHANCE = 0.5;
export const CONTROL_SCRAP_PIECES = 1;

/**
 * Сколько штук бракует контроль.
 *
 * `draw` — число из полуинтервала [0, 1) от генератора контроля.
 * Если оно попало в вероятность, контроль находит `pieces` штук брака,
 * но не больше, чем пришло. Иначе брака нет.
 */
export function controlScrapFor(draw: number, portion: number, pieces = CONTROL_SCRAP_PIECES, chance = CONTROL_SCRAP_CHANCE): number {
  if (!(draw >= 0 && draw < 1)) {
    throw new Error('Генератор контроля вернул число вне полуинтервала [0, 1).');
  }
  if (!(chance >= 0 && chance <= 1)) {
    throw new Error('Вероятность брака контроля должна быть в отрезке [0, 1].');
  }
  if (!Number.isInteger(pieces) || pieces < 0) {
    throw new Error('Брак контроля должен быть целым числом штук.');
  }
  if (!Number.isInteger(portion) || portion <= 0) {
    throw new Error('Порция контроля должна быть целым положительным числом штук.');
  }
  if (draw >= chance) {
    return 0;
  }
  return Math.min(pieces, portion);
}

export function areaDecidesFitness(areaId: string): boolean {
  return ROUTE.some((step) => step.areaId === areaId && step.decidesFitness);
}

export function scheduleOf(kind: ResourceKind): Schedule {
  switch (kind) {
    case 'machines':
      return 'queue';
    case 'furnaces':
      return 'charge-day';
    case 'personnel':
      return 'shift';
    case 'cooperation':
      return 'external-lead';
  }
}

/**
 * Маршрут MVP из карты потоков.
 * Длительности — модельные, чтобы партия была видна на горизонте 12 смен.
 * Сутки садки термообработки — правило документа, не подгонка.
 * Пропорции ожидания живого цеха сюда не зашиты: очередь должна возникать из ёмкости.
 */
export const ROUTE: readonly RouteStep[] = [
  {
    areaId: 'area-cnc-turn',
    areaName: 'Токарная ЧПУ',
    role: { role: 'processing', resourceKind: 'machines', schedule: 'queue' },
    effort: quantity('machine-hour', 4),
    decidesFitness: false,
    evidence: 'confirmed',
    evidenceNote: 'Участок карты. Тип «станки», станок планируется очередью.',
  },
  {
    areaId: 'area-mill',
    areaName: 'Фрезерная',
    role: { role: 'processing', resourceKind: 'machines', schedule: 'queue' },
    effort: quantity('machine-hour', 4),
    decidesFitness: false,
    evidence: 'confirmed',
    evidenceNote: 'Участок карты. Очередь по фрезерным станкам есть в описании ёмкостной модели.',
  },
  {
    areaId: 'area-heat',
    areaName: 'Термообработка',
    role: { role: 'processing', resourceKind: 'furnaces', schedule: 'charge-day' },
    effort: quantity('charge-day', 1),
    decidesFitness: false,
    evidence: 'confirmed',
    evidenceNote: 'Печь планируется садкой, срок садки — одни сутки.',
  },
  {
    areaId: 'area-bench',
    areaName: 'Слесарная',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 6),
    decidesFitness: false,
    evidence: 'hypothesis',
    evidenceNote: 'Тип «персонал» в документах есть. Поимённая привязка слесарной к персоналу не найдена.',
  },
  {
    areaId: 'area-test',
    areaName: 'Испытательная',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 4),
    decidesFitness: true,
    evidence: 'hypothesis',
    evidenceNote: 'Документы не назначают тип ресурса этому участку. На стенде принят человек и смена. Участок решает годность.',
  },
  {
    areaId: 'area-final',
    areaName: 'Окончательный контроль',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 2),
    decidesFitness: true,
    evidence: 'limitation',
    evidenceNote: 'Пул ОТК в глоссарии — контролёры на длительность смены. Участок решает годность.',
  },
  {
    areaId: 'area-fg',
    areaName: 'Склад ГП',
    role: { role: 'warehouse' },
    effort: null,
    decidesFitness: false,
    evidence: 'confirmed',
    evidenceNote: 'Конечная точка маршрута на карте потоков. Не ресурс четырёх типов.',
  },
];

if (ROUTE.length !== 7) {
  throw new Error('Маршрут стенда должен содержать 7 шагов.');
}
