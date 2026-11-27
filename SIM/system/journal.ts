import { instant, type SimInstant } from '../contract/time.ts';
import type { MetricId } from './metrics.ts';

export type Verdict = 'confirmed' | 'diverged' | 'unverifiable';

export interface DecisionRecord {
  readonly at: SimInstant;
  readonly action: string;
  readonly basisMetric: MetricId;
  readonly basisValue: string;
  readonly coverage: number;
  readonly consequence: string;
}

export interface ReviewLine {
  readonly decision: DecisionRecord;
  readonly verdict: Verdict;
}

const VERDICTS: readonly Verdict[] = ['confirmed', 'diverged', 'unverifiable'];

export function recordDecision(input: DecisionRecord): DecisionRecord {
  if (input.action.trim().length === 0) {
    throw new Error('В журнале пустое действие.');
  }
  if (!Number.isFinite(input.coverage) || input.coverage < 0 || input.coverage > 1) {
    throw new Error('Покрытие в журнале — доля от 0 до 1.');
  }
  return Object.freeze({ ...input });
}

/** Приём или отложение заказа. Покрытие — доля на момент решения, не оценка решения. */
export function orderDecisionRecord(input: {
  readonly type: 'accept-order' | 'defer-order';
  readonly orderId: string;
  readonly at: number;
  readonly basisMetric: MetricId;
  readonly basisValue: string;
  readonly coverage: number;
}): DecisionRecord {
  const accepting = input.type === 'accept-order';
  return recordDecision({
    at: instant(input.at),
    action: accepting ? `принять заказ ${input.orderId}` : `отложить заказ ${input.orderId}`,
    basisMetric: input.basisMetric,
    basisValue: input.basisValue,
    coverage: input.coverage,
    consequence: accepting
      ? 'партии заказа запускаются в цех с этого момента, заказ входит в покрытие'
      : 'заказ остаётся неразобранным, партии не запускаются, покрытие не растёт',
  });
}

/** Разбор — протокол. Балла и рейтинга в типе записи нет. */
export function review(lines: readonly ReviewLine[]): readonly ReviewLine[] {
  return Object.freeze(
    lines.map((line) => {
      if (!VERDICTS.includes(line.verdict)) {
        throw new Error('Итог разбора: подтвердилось, разошлось или невозможно проверить.');
      }
      return Object.freeze({ decision: recordDecision(line.decision), verdict: line.verdict });
    }),
  );
}
