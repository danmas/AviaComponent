/**
 * Реестр событий потока закрытым списком: клиент знает, что обязан понимать,
 * и не падает на типе, которого нет в его версии.
 */
export const EVENT_TYPES = [
  'shift-started',
  'shift-completed',
  'metrics-updated',
  'decision-applied',
  'session-finished',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isKnownEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** Окно журнала: 15 смен по ~4 события плюс запас на решения. */
export const JOURNAL_WINDOW = 200;

export interface JournalEntry {
  readonly seq: number;
  readonly type: string;
}

export interface WindowExceeded {
  readonly error: 'journal-window-exceeded';
  readonly oldestSeq: number;
}

export interface ReplaySlice<T extends JournalEntry> {
  readonly events: readonly T[];
  readonly exceeded: WindowExceeded | null;
}

/**
 * События после lastSeq в пределах окна. Запрос старше окна — отказ с самым старым
 * доступным номером: клиент перечитывает срез с нуля, потери нет.
 */
export function replayWithinWindow<T extends JournalEntry>(
  events: readonly T[],
  lastSeq: number,
  window: number = JOURNAL_WINDOW,
): ReplaySlice<T> {
  if (events.length === 0) {
    return { events: [], exceeded: null };
  }
  const oldest = events[0];
  const newest = events[events.length - 1];
  if (oldest === undefined || newest === undefined) {
    return { events: [], exceeded: null };
  }
  if (lastSeq < oldest.seq - 1 && oldest.seq > 1) {
    return { events: [], exceeded: { error: 'journal-window-exceeded', oldestSeq: oldest.seq } };
  }
  return { events: events.filter((event) => event.seq > lastSeq), exceeded: null };
}

/** Оставляет последние записи окна. */
export function trimToWindow<T>(events: T[], window: number = JOURNAL_WINDOW): T[] {
  if (events.length <= window) {
    return events;
  }
  return events.slice(events.length - window);
}
