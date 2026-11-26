import type { SimInstant } from '../contract/time.ts';
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
