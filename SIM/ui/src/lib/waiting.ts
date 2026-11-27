/**
 * Пролёживание операции. Три разных состояния, которые нельзя склеивать:
 * ещё не готова, лежит прямо сейчас, пролежала и уже начата.
 *
 * Считается только разница моментов. Правил модели здесь нет: момент
 * готовности и старт приходят из среза цеха.
 */

export type WaitingState = 'not-ready' | 'waiting' | 'finished';

export interface Waiting {
  readonly state: WaitingState;
  /** Минуты ожидания. У `not-ready` — ноль, но он не показывается как ожидание. */
  readonly minutes: number;
  /** Часы с одним знаком после запятой — для чтения человеком. */
  readonly hours: number;
}

export interface WaitingInput {
  readonly status: string;
  readonly readyAt: number | null;
  readonly startedAt: number | null;
  readonly now: number;
}

/** Старт операции из среза: ресурс занят ею, значит она в работе или уже закрыта. */
export function waitingOf(input: WaitingInput): Waiting {
  if (input.readyAt === null) {
    return { state: 'not-ready', minutes: 0, hours: 0 };
  }
  // Начатая операция: ожидание закончилось и не растёт. Закрытая тоже сюда:
  // у неё был старт, и после него ожидания нет.
  const end = input.startedAt ?? (input.status === 'ready' ? input.now : null);
  if (end === null) {
    return { state: 'not-ready', minutes: 0, hours: 0 };
  }
  const minutes = end - input.readyAt;
  return {
    state: input.status === 'ready' ? 'waiting' : 'finished',
    minutes: minutes < 0 ? 0 : minutes,
    hours: Math.round((minutes < 0 ? 0 : minutes) / 6) / 10,
  };
}

const NOT_READY_TEXT = 'ещё не готова';

/** Строка для экрана: «лежит 6000 мин (100 ч)», «пролежала 1200 мин (20 ч)», «ещё не готова». */
export function waitingText(waiting: Waiting): string {
  if (waiting.state === 'not-ready') {
    return NOT_READY_TEXT;
  }
  const verb = waiting.state === 'waiting' ? 'лежит' : 'пролежала';
  return `${verb} ${waiting.minutes} мин (${waiting.hours} ч)`;
}
