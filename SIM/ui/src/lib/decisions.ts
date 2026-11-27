/**
 * Решения свода. Цена не считается: поля копируются из ответа сервера.
 * Последствие, которого сервер ещё не прислал, не выдумывается.
 */
import { coverageText } from './coverage.ts';
import { formatBasisValue, METRIC_TITLE, type MetricId } from './metrics.ts';

export const DECISION_TYPES = ['priority', 'accept-order', 'defer-order'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Верхняя граница из правил игры: не больше трёх решений за смену. */
export const DECISION_LIMIT = 3;

/** Длина смены в минутах. Сервер датирует решение её началом. */
export const SHIFT_MINUTES = 720;

export const DECISION_TITLE: Record<DecisionType, string> = {
  priority: 'приоритет партии',
  'accept-order': 'принять заказ',
  'defer-order': 'отложить заказ',
};

/**
 * Какой показатель сервер пишет в журнал как основание.
 * До ответа это только выбор поля уже пришедшего среза, не расчёт.
 */
export function basisOf(type: DecisionType): MetricId {
  return type === 'priority' ? 'scheduleRisk' : 'portfolio';
}

export function decisionsInShift<T extends { readonly at: number }>(
  journal: readonly T[],
  shift: number,
): readonly T[] {
  const start = shift * SHIFT_MINUTES;
  const end = start + SHIFT_MINUTES;
  return journal.filter((row) => row.at >= start && row.at < end);
}

export function counterText(count: number): string {
  return `решено ${count} из ${DECISION_LIMIT}`;
}

export function limitNote(count: number): string | null {
  if (count < DECISION_LIMIT) {
    return null;
  }
  return 'За смену уже три решения. Четвёртое действие недоступно до следующей смены.';
}

export interface PriceInput {
  readonly basisMetric: string;
  readonly basisValue: string;
  readonly coverage: number;
  readonly consequence?: string | null;
}

export interface PriceView {
  readonly basisMetric: string;
  readonly basisTitle: string;
  readonly basisValue: string;
  readonly valueText: string;
  readonly coverage: number;
  readonly coverageLabel: string;
  readonly consequence: string;
}

const MISSING_CONSEQUENCE = 'последствие: см. журнал';

/** Четыре поля цены. Пустое последствие не заменяется выдуманным текстом. */
export function decisionPrice(input: PriceInput): PriceView {
  const known = METRIC_TITLE[input.basisMetric as MetricId];
  const consequence = input.consequence === undefined || input.consequence === null || input.consequence.trim() === ''
    ? MISSING_CONSEQUENCE
    : input.consequence;
  return {
    basisMetric: input.basisMetric,
    basisTitle: known ?? input.basisMetric,
    basisValue: input.basisValue,
    valueText: formatBasisValue(input.basisMetric, input.basisValue),
    coverage: input.coverage,
    coverageLabel: `покрытие основания: ${coverageText(input.coverage)}`,
    consequence,
  };
}

export interface JournalView {
  readonly at: number;
  readonly action: string;
  readonly basis: string;
  readonly coverage: number;
  readonly consequence: string;
}

/** Пять полей записи. Балла и оценки в результате нет. */
export function journalViews(journal: readonly {
  readonly at: number;
  readonly action: string;
  readonly basisMetric: string;
  readonly basisValue: string;
  readonly coverage: number;
  readonly consequence: string;
}[]): readonly JournalView[] {
  return journal.map((row) => {
    const known = METRIC_TITLE[row.basisMetric as MetricId];
    const value = formatBasisValue(row.basisMetric, row.basisValue);
    return {
      at: row.at,
      action: row.action,
      basis: `${known ?? row.basisMetric}${value === '' ? '' : ` — ${value}`}`,
      coverage: row.coverage,
      consequence: row.consequence,
    };
  });
}
