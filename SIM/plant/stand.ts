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
  readonly evidence: Evidence;
  readonly evidenceNote: string;
}

/**
 * Ёмкости стенда. Числа модельные: живой завод в стенд не копируется.
 * Садка — 4 штуки, один ресурс на участок. Это не паспорт цеха.
 */
export const PLANT_STAND = {
  furnaceChargePieces: 4,
  resourcesPerArea: 1,
} as const;

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
    evidence: 'confirmed',
    evidenceNote: 'Участок карты. Тип «станки», станок планируется очередью.',
  },
  {
    areaId: 'area-mill',
    areaName: 'Фрезерная',
    role: { role: 'processing', resourceKind: 'machines', schedule: 'queue' },
    effort: quantity('machine-hour', 4),
    evidence: 'confirmed',
    evidenceNote: 'Участок карты. Очередь по фрезерным станкам есть в описании ёмкостной модели.',
  },
  {
    areaId: 'area-heat',
    areaName: 'Термообработка',
    role: { role: 'processing', resourceKind: 'furnaces', schedule: 'charge-day' },
    effort: quantity('charge-day', 1),
    evidence: 'confirmed',
    evidenceNote: 'Печь планируется садкой, срок садки — одни сутки.',
  },
  {
    areaId: 'area-bench',
    areaName: 'Слесарная',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 6),
    evidence: 'hypothesis',
    evidenceNote: 'Тип «персонал» в документах есть. Поимённая привязка слесарной к персоналу не найдена.',
  },
  {
    areaId: 'area-test',
    areaName: 'Испытательная',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 4),
    evidence: 'hypothesis',
    evidenceNote: 'Документы не назначают тип ресурса этому участку. На стенде принят человек и смена.',
  },
  {
    areaId: 'area-final',
    areaName: 'Окончательный контроль',
    role: { role: 'processing', resourceKind: 'personnel', schedule: 'shift' },
    effort: quantity('person-hour', 2),
    evidence: 'limitation',
    evidenceNote: 'Пул ОТК в глоссарии — контролёры на длительность смены. Это чтение, не таблица типов участков.',
  },
  {
    areaId: 'area-fg',
    areaName: 'Склад ГП',
    role: { role: 'warehouse' },
    effort: null,
    evidence: 'confirmed',
    evidenceNote: 'Конечная точка маршрута на карте потоков. Не ресурс четырёх типов.',
  },
];

if (ROUTE.length !== 7) {
  throw new Error('Маршрут стенда должен содержать 7 шагов.');
}
