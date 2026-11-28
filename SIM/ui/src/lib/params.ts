/**
 * Параметры экрана из адреса. Нужны для воспроизводимых снимков и ссылок
 * на конкретное состояние: `?shift=3&mode=movement&overlay=breakdown`.
 * Без параметров экран ведёт себя как раньше: смена 0, режим «сейчас».
 */
export interface ScreenParams {
  readonly shift: number;
  readonly mode: 'now' | 'movement';
  readonly overlay: 'none' | 'urgent' | 'breakdown' | 'scrap' | 'incoming';
  readonly level: 'clean' | 'late' | 'paper' | 'empty';
  readonly seed: number;
  readonly view: 'shop' | 'dashboard' | 'review';
}

const OVERLAYS = ['none', 'urgent', 'breakdown', 'scrap', 'incoming'] as const;
const LEVELS = ['clean', 'late', 'paper', 'empty'] as const;
const VIEWS = ['shop', 'dashboard', 'review'] as const;

function whole(value: string | null, fallback: number, min = 0): number {
  if (value === null || !/^[0-9]+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function screenParams(search: string = globalThis.location?.search ?? ''): ScreenParams {
  const query = new URLSearchParams(search);
  const overlay = query.get('overlay');
  const level = query.get('level');
  const mode = query.get('mode');
  const view = query.get('view');
  return {
    shift: whole(query.get('shift'), 0),
    mode: mode === 'movement' ? 'movement' : 'now',
    overlay: OVERLAYS.includes(overlay as (typeof OVERLAYS)[number])
      ? (overlay as ScreenParams['overlay'])
      : 'none',
    level: LEVELS.includes(level as (typeof LEVELS)[number]) ? (level as ScreenParams['level']) : 'clean',
    seed: whole(query.get('seed'), 42, 1),
    view: VIEWS.includes(view as (typeof VIEWS)[number]) ? (view as ScreenParams['view']) : 'shop',
  };
}
