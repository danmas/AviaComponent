import { nextShiftStart, type SimInstant } from './time.ts';
import { parseEventV1, type MasterCloseV1 } from './v1/events.ts';

/** Дисциплина мастера — параметр уровня. В первой версии она заменяет табель и допуски. */
export type MasterDiscipline = 'immediate' | 'next-shift' | 'paper' | 'skip';

export interface MarkInput {
  readonly operationId: string;
  readonly trueTime: SimInstant;
  readonly piecesDone: number;
  readonly piecesScrap: number;
  readonly discipline: MasterDiscipline;
}

export interface MarkOutcome {
  readonly discipline: MasterDiscipline;
  /** Видно разбору и цеху. В событие Системы не входит. */
  readonly plantNote: 'recorded' | 'paper' | 'skip';
  readonly systemEvent: MasterCloseV1 | null;
}

/**
 * Бумага и пропуск не создают событие и не ставят признак «пропущено».
 * Для Системы оба случая — дыра. Различает их только заметка цеха.
 */
export function markByDiscipline(input: MarkInput): MarkOutcome {
  if (input.discipline === 'paper' || input.discipline === 'skip') {
    return { discipline: input.discipline, plantNote: input.discipline, systemEvent: null };
  }
  const recordTime = input.discipline === 'immediate' ? input.trueTime : nextShiftStart(input.trueTime);
  const systemEvent = parseEventV1({
    version: 1,
    type: 'master-close',
    author: 'master',
    flow: 'into-system',
    operationId: input.operationId,
    piecesDone: input.piecesDone,
    piecesScrap: input.piecesScrap,
    trueTime: input.trueTime,
    recordTime,
  });
  if (systemEvent.type !== 'master-close') {
    throw new Error('Отметка мастера разобрана не тем типом.');
  }
  return { discipline: input.discipline, plantNote: 'recorded', systemEvent };
}
