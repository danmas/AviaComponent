import type { MasterDiscipline } from '../contract/discipline.ts';

export const LEVEL_NAMES = ['clean', 'late', 'paper', 'empty'] as const;
export type LevelName = (typeof LEVEL_NAMES)[number];

export const OVERLAY_NAMES = ['none', 'urgent', 'breakdown', 'scrap'] as const;
export type OverlayName = (typeof OVERLAY_NAMES)[number];

export interface LevelRule {
  readonly outsideShare: number;
  readonly miss: 'paper' | 'skip';
  readonly discipline: MasterDiscipline;
}

/** Доли зафиксированы до прогона. 5% — точка «около 95%». 35% — середина диапазона 30–40. */
export const LEVEL_RULES: Record<LevelName, LevelRule> = {
  clean: { outsideShare: 0.05, miss: 'skip', discipline: 'immediate' },
  late: { outsideShare: 0, miss: 'skip', discipline: 'next-shift' },
  paper: { outsideShare: 0.35, miss: 'paper', discipline: 'immediate' },
  empty: { outsideShare: 0, miss: 'skip', discipline: 'immediate' },
};

/** Знаменатели покрытия. Не заменяются числом закрытий конкретного прогона. */
export const EXPECTED = {
  orders: 4,
  loadAreas: 6,
  marks: 36,
} as const;

export function disciplineDecision(
  rule: LevelRule,
  draw: number | null,
): { readonly discipline: MasterDiscipline; readonly miss: 'paper' | 'skip' | null } {
  if (rule.outsideShare > 0) {
    if (draw === null || !(draw >= 0 && draw < 1)) {
      throw new Error('Доля вне Системы требует жребия из полуинтервала [0, 1).');
    }
    if (draw < rule.outsideShare) {
      return { discipline: rule.discipline, miss: rule.miss };
    }
  }
  return { discipline: rule.discipline, miss: null };
}
