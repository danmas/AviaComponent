/**
 * Состояние прогона общее для цеха, свода и разбора.
 * Переключение экрана не меняет сессию и смену и не создаёт новый прогон.
 */
export type ScreenId = 'shop' | 'dashboard' | 'review';

export interface PlayState {
  readonly sessionId: string;
  readonly viewShift: number;
  readonly serverShift: number;
  readonly shiftCount: number;
  readonly screen: ScreenId;
}

export const SCREEN_TABS = [
  { id: 'shop', label: 'цех' },
  { id: 'dashboard', label: 'свод' },
  { id: 'review', label: 'разбор' },
] as const;

export function tabsOf(screen: ScreenId): readonly { id: ScreenId; label: string; active: boolean }[] {
  return SCREEN_TABS.map((tab) => ({ id: tab.id, label: tab.label, active: tab.id === screen }));
}

export function openScreen(state: PlayState, screen: ScreenId): PlayState {
  return {
    sessionId: state.sessionId,
    viewShift: state.viewShift,
    serverShift: state.serverShift,
    shiftCount: state.shiftCount,
    screen,
  };
}

/** Смотреть уже выданную смену, не двигая серверную. */
export function viewShift(state: PlayState, shift: number): PlayState {
  return { ...state, viewShift: shift };
}

/** После шага смены смотрим ту смену, на которой теперь сервер. */
export function followServer(state: PlayState, serverShift: number): PlayState {
  return { ...state, serverShift, viewShift: serverShift };
}
