/**
 * Проигрывание следа: что происходит в цехе на выбранной минуте.
 *
 * Экран игры не запрашивает срез цеха — он читает только след. Всё, что здесь
 * считается, выводится из событий и кадров следа: положение партий, очереди,
 * показатели. Ни одного правила цеха здесь не повторяется — только чтение.
 *
 * Цвет и порядок участков заданы здесь как представление: след несёт `areaId`,
 * а не название участка. Порядок шагов тот же, что в GAME.md.
 */
import type { TraceResponse } from '../../../api-client/types.ts';

export type Trace = TraceResponse;
export type TraceEvent = Trace['events'][number];
export type TraceFrame = Trace['frames'][number];

/** Семь шагов маршрута: подпись и порядок для схемы. Не правило, а название. */
export const ROUTE_STEPS = [
  { areaId: 'area-cnc-turn', areaName: 'Токарная' },
  { areaId: 'area-mill', areaName: 'Фрезерная' },
  { areaId: 'area-heat', areaName: 'Термообработка' },
  { areaId: 'area-bench', areaName: 'Слесарная' },
  { areaId: 'area-test', areaName: 'Испытательная' },
  { areaId: 'area-final', areaName: 'Окончательный контроль' },
  { areaId: 'area-fg', areaName: 'Склад ГП' },
] as const;

export type BatchStatus = 'ready' | 'running' | 'done' | 'not-ready';

export interface BatchAt {
  readonly batchId: string;
  readonly orderId: string | null;
  readonly areaId: string | null;
  /** Шаг маршрута: 1..7. Ноль — партия ещё не пришла в цех. */
  readonly step: number;
  readonly status: BatchStatus;
  readonly qty: number;
  /** Сколько пролежала на текущем участке к выбранной минуте. */
  readonly waitedMinutes: number;
  /** Минута появления партии в цехе. */
  readonly appearedAt: number;
}

export interface AreaAt {
  readonly areaId: string;
  readonly areaName: string;
  readonly step: number;
  /** Сколько партий ждёт запуска (готовы, но не взяты). */
  readonly waiting: number;
  readonly running: number;
  readonly done: number;
}

export interface GameAt {
  readonly minute: number;
  readonly shift: number;
  readonly batches: readonly BatchAt[];
  readonly areas: readonly AreaAt[];
  readonly frame: TraceFrame | null;
  /** Сколько всего событий уже случилось — для счётчика. */
  readonly eventsSeen: number;
}

function stepOf(operationId: string): number {
  const match = /-op-(\d+)$/.exec(operationId);
  return match === null ? 0 : Number(match[1]) + 1;
}

function areaName(areaId: string | null): string {
  if (areaId === null) {
    return '—';
  }
  return ROUTE_STEPS.find((step) => step.areaId === areaId)?.areaName ?? areaId;
}

export interface TraceSpan {
  /** Первая минута прогона. */
  readonly from: number;
  /** Последняя минута прогона: граница последнего кадра. */
  readonly to: number;
  readonly shiftMinutes: number;
  readonly shifts: number;
}

export function spanOf(trace: Trace): TraceSpan {
  const shiftMinutes = trace.meta.shiftMinutes;
  const shifts = trace.meta.horizonShifts;
  return { from: 0, to: shifts * shiftMinutes, shiftMinutes, shifts };
}

/** Границы смен: для полосы перемотки. */
export function shiftStarts(trace: Trace): readonly number[] {
  const span = spanOf(trace);
  const starts: number[] = [];
  for (let shift = 0; shift < span.shifts; shift += 1) {
    starts.push(shift * span.shiftMinutes);
  }
  return starts;
}

/** Кадр, действующий на этой минуте: последняя граница смены не позже минуты. */
export function frameAt(trace: Trace, minute: number): TraceFrame | null {
  let found: TraceFrame | null = null;
  for (const frame of trace.frames) {
    if (frame.at <= minute) {
      found = frame;
    }
  }
  return found;
}

/**
 * Положение партий на минуте.
 *
 * Считается по событиям, а не по кадрам: кадры есть только на границах смен,
 * а движение внутри смены видно лишь из событий. Кадр остаётся точкой сверки.
 *
 * Операция закрыта — партия уже не на этом участке: она ждёт следующего шага.
 * Поэтому закрытие сдвигает партию на шаг вперёд и ставит в ожидание, даже
 * если события готовности следующей операции ещё нет.
 */
export function batchesAt(trace: Trace, minute: number): readonly BatchAt[] {
  const appeared = new Map<string, { at: number; orderId: string | null; qty: number }>();
  for (const event of trace.events) {
    if (event.type === 'batch-appeared' && event.batchId !== undefined && event.appearedAt !== undefined) {
      appeared.set(event.batchId, {
        at: event.appearedAt,
        orderId: event.orderId ?? null,
        qty: event.qty ?? 0,
      });
    }
  }

  const rows: BatchAt[] = [];
  for (const [batchId, info] of appeared) {
    if (info.at > minute) {
      continue;
    }
    const own = trace.events
      .filter((event) => event.batchId === batchId && event.at <= minute)
      .filter((event) => event.operationId !== undefined)
      .sort((left, right) => left.at - right.at);

    const last = own[own.length - 1];
    if (last === undefined) {
      rows.push({
        batchId,
        orderId: info.orderId,
        areaId: null,
        step: 0,
        status: 'not-ready',
        qty: info.qty,
        waitedMinutes: 0,
        appearedAt: info.at,
      });
      continue;
    }

    const closed = last.type === 'operation-completed';
    const lastStep = stepOf(last.operationId ?? '');
    // Закрытая операция отпускает партию: она встаёт на следующий шаг и ждёт.
    const step = closed ? Math.min(lastStep + 1, ROUTE_STEPS.length) : lastStep;
    const areaId = closed ? (ROUTE_STEPS[step - 1]?.areaId ?? null) : (last.areaId ?? null);
    const status: BatchStatus = closed
      ? step >= ROUTE_STEPS.length
        ? 'done'
        : 'ready'
      : last.type === 'operation-started'
        ? 'running'
        : 'ready';

    // Пролёживание: от готовности текущей операции до выбранной минуты.
    // После закрытия партия ждёт с минуты закрытия — раньше готовности следующей
    // операции может не быть, а ждать она уже начала.
    const ready = [...own].reverse().find((event) => event.type === 'operation-ready' && event.areaId === areaId);
    const since = closed ? last.at : ready?.readyAt;
    const waitedMinutes = status === 'ready' && since !== undefined
      ? Math.max(0, minute - since)
      : 0;

    rows.push({
      batchId,
      orderId: info.orderId,
      areaId,
      step,
      status,
      qty: info.qty,
      waitedMinutes,
      appearedAt: info.at,
    });
  }
  return rows.sort((left, right) => left.batchId.localeCompare(right.batchId));
}

/** Загрузка участков на минуте: сколько ждёт, работает, закрыто. */
export function areasAt(trace: Trace, minute: number): readonly AreaAt[] {
  const batches = batchesAt(trace, minute);
  const rows: AreaAt[] = [];
  for (let index = 0; index < ROUTE_STEPS.length; index += 1) {
    const step = ROUTE_STEPS[index];
    if (step === undefined) {
      continue;
    }
    const here = batches.filter((batch) => batch.areaId === step.areaId);
    rows.push({
      areaId: step.areaId,
      areaName: step.areaName,
      step: index + 1,
      waiting: here.filter((batch) => batch.status === 'ready').length,
      running: here.filter((batch) => batch.status === 'running').length,
      done: here.filter((batch) => batch.status === 'done').length,
    });
  }
  return rows;
}

export function gameAt(trace: Trace, minute: number): GameAt {
  const span = spanOf(trace);
  const clamped = Math.min(Math.max(minute, span.from), span.to);
  return {
    minute: clamped,
    shift: Math.min(Math.floor(clamped / span.shiftMinutes), span.shifts - 1),
    batches: batchesAt(trace, clamped),
    areas: areasAt(trace, clamped),
    frame: frameAt(trace, clamped),
    eventsSeen: trace.events.filter((event) => event.at <= clamped).length,
  };
}

/** Ближайшая минута следующего события — для шага «дальше». */
export function nextEventMinute(trace: Trace, minute: number): number | null {
  const later = trace.events
    .map((event) => event.at)
    .filter((at) => at > minute)
    .sort((left, right) => left - right);
  return later[0] ?? null;
}

/** Показатели кадра в виде строк: подпись, значение, покрытие. */
export function frameReadings(frame: TraceFrame): readonly {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly coverage: number;
}[] {
  return [
    {
      id: 'portfolio',
      title: 'Портфель',
      text: `открыто ${frame.metrics.portfolio.value.openCount}, остаток ${frame.metrics.portfolio.value.remainderNormHours} н/ч`,
      coverage: frame.metrics.portfolio.coverage,
    },
    {
      id: 'overload',
      title: 'Перегрузка',
      text: `участков с очередью ${frame.metrics.overload.value.overloadedCount}`,
      coverage: frame.metrics.overload.coverage,
    },
    {
      id: 'acceptedShift',
      title: 'Принято за смену',
      text: `${frame.metrics.acceptedShift.value.normHours} н/ч, мастер ${frame.metrics.acceptedShift.value.masterCloses}`,
      coverage: frame.metrics.acceptedShift.coverage,
    },
    {
      id: 'scheduleRisk',
      title: 'Риск сроков',
      text: `просрочено ${frame.metrics.scheduleRisk.value.overdue}, в срок ${frame.metrics.scheduleRisk.value.onTime}`,
      coverage: frame.metrics.scheduleRisk.coverage,
    },
  ];
}

export { areaName };
