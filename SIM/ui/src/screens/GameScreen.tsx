/**
 * Экран игры: производство в движении по следу прогона.
 *
 * Читает только след. Срез цеха не запрашивается — этим экран игры отличается
 * от разбора, где правда цеха открывается намеренно.
 *
 * Цвет различает состояния, но не оценивает: ждёт, работает, закрыто.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { client } from '../lib/api.ts';
import {
  frameReadings,
  gameAt,
  nextEventMinute,
  ROUTE_STEPS,
  shiftStarts,
  spanOf,
  type BatchStatus,
  type GameAt,
  type Trace,
} from '../lib/game.ts';
import type { PlayState } from '../lib/session.ts';
import { ScreenTabs } from './ScreenTabs.tsx';

const STATUS_WORD: Record<BatchStatus, string> = {
  'not-ready': 'ждёт',
  ready: 'в очереди',
  running: 'в работе',
  done: 'закрыт',
};

/** Плотность линии несёт состояние, а не оценку. */
const STATUS_CLASS: Record<BatchStatus, string> = {
  'not-ready': 'st-quiet',
  ready: 'st-wait',
  running: 'st-run',
  done: 'st-done',
};

function clock(minute: number): string {
  const total = Math.max(0, Math.round(minute));
  const shiftMinutes = 720;
  const shift = Math.floor(total / shiftMinutes);
  const inside = total - shift * shiftMinutes;
  const hours = Math.floor(inside / 60);
  const minutes = inside % 60;
  return `смена ${shift} · ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function GameScreen(props: {
  readonly play: PlayState;
  readonly onScreen: (screen: 'shop' | 'dashboard' | 'review' | 'game') => void;
  readonly onStep: () => Promise<void>;
}): JSX.Element {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minute, setMinute] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await client.trace(props.play.sessionId);
        if (!alive) {
          return;
        }
        setTrace(loaded as unknown as Trace);
        setMinute((loaded.meta.horizonShifts - 1) * loaded.meta.shiftMinutes);
      } catch (caught: unknown) {
        if (alive) {
          setError(caught instanceof Error ? caught.message : 'След недоступен');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.play.sessionId]);

  const span = useMemo(() => (trace === null ? null : spanOf(trace)), [trace]);
  const state: GameAt | null = useMemo(
    () => (trace === null ? null : gameAt(trace, minute)),
    [trace, minute],
  );

  useEffect(() => {
    if (!playing || span === null) {
      return;
    }
    const tick = span.shiftMinutes / 24;
    timer.current = globalThis.setInterval(() => {
      setMinute((current) => {
        const next = current + tick;
        if (next >= span.to) {
          setPlaying(false);
          return span.to;
        }
        return next;
      });
    }, 80) as unknown as number;
    return () => {
      if (timer.current !== null) {
        globalThis.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [playing, span]);

  if (error !== null) {
    return (
      <div className="sheet game-sheet" data-ready="error">
        <h1>След недоступен</h1>
        <p className="ink-faint">{error}</p>
        <ScreenTabs screen="game" onScreen={props.onScreen} />
      </div>
    );
  }

  if (trace === null || span === null || state === null) {
    return (
      <div className="sheet game-sheet">
        <h1>Читаем след…</h1>
      </div>
    );
  }

  const starts = shiftStarts(trace);
  const next = nextEventMinute(trace, minute);

  function seek(value: number): void {
    setPlaying(false);
    setMinute(Math.min(Math.max(value, span!.from), span!.to));
  }

  return (
    <div className="sheet game-sheet" data-ready="true">
      <header className="sheet-head">
        <div>
          <h1>Производство в движении</h1>
          <div className="sub">{clock(state.minute)} · событий пройдено {state.eventsSeen} из {trace.events.length}</div>
        </div>
        <ScreenTabs screen="game" onScreen={props.onScreen} />
      </header>

      <section className="game-controls">
        <button type="button" onClick={() => seek(span.from)} title="в начало">
          ⏮
        </button>
        <button type="button" onClick={() => seek(minute - span.shiftMinutes)} title="смена назад">
          ◀ смена
        </button>
        <button type="button" className="play" onClick={() => setPlaying((on) => !on)}>
          {playing ? '❙❙ пауза' : '▶ играть'}
        </button>
        <button
          type="button"
          onClick={() => (playing ? setPlaying(false) : seek(next ?? minute))}
          title="следующее событие"
        >
          событие ⏭
        </button>
        <button type="button" onClick={() => seek(minute + span.shiftMinutes)} title="смена вперёд">
          смена ▶
        </button>
        <button type="button" onClick={() => seek(span.to)} title="в конец">
          ⏭
        </button>
      </section>

      <section className="game-scrub">
        <input
          type="range"
          min={span.from}
          max={span.to}
          step={10}
          value={Math.round(minute)}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          aria-label="время прогона"
        />
        <div className="shift-marks">
          {starts.map((at) => (
            <button
              key={at}
              type="button"
              className={at === state.shift * span.shiftMinutes ? 'mark on' : 'mark'}
              onClick={() => seek(at)}
              title={`смена ${at / span.shiftMinutes}`}
            >
              {at / span.shiftMinutes}
            </button>
          ))}
        </div>
      </section>

      <section className="game-route">
        {state.areas.map((area) => (
          <div key={area.areaId} className="game-area">
            <div className="area-head">
              <span className="step-no">{area.step}</span>
              <span className="area-name">{area.areaName}</span>
            </div>
            <div className="area-queue">
              <span className="q-wait" title="в очереди">{area.waiting}</span>
              <span className="q-run" title="в работе">{area.running}</span>
            </div>
            <div className="area-batches">
              {state.batches
                .filter((batch) => batch.areaId === area.areaId)
                .map((batch) => (
                  <div key={batch.batchId} className={`chip ${STATUS_CLASS[batch.status]}`}>
                    <span className="chip-id">{batch.batchId.replace('batch-', 'п')}</span>
                    <span className="chip-st">{STATUS_WORD[batch.status]}</span>
                    {batch.waitedMinutes > 0 ? (
                      <span className="chip-wait">{Math.round(batch.waitedMinutes / 60)} ч</span>
                    ) : null}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </section>

      <section className="game-below">
        <div className="game-metrics">
          <h2>Показатели на смену</h2>
          {state.frame === null ? (
            <p className="ink-faint">до первой границы смены</p>
          ) : (
            <table className="readings">
              <tbody>
                {frameReadings(state.frame).map((row) => (
                  <tr key={row.id}>
                    <td>{row.title}</td>
                    <td>{row.text}</td>
                    <td className={row.coverage < 1 ? 'cov low' : 'cov'}>{row.coverage.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="game-batches">
          <h2>Партии</h2>
          <table className="readings">
            <thead>
              <tr>
                <th>партия</th>
                <th>заказ</th>
                <th>шаг</th>
                <th>состояние</th>
                <th>пролежала</th>
              </tr>
            </thead>
            <tbody>
              {state.batches.map((batch) => (
                <tr key={batch.batchId}>
                  <td>{batch.batchId}</td>
                  <td>{batch.orderId ?? '—'}</td>
                  <td>
                    {batch.step === 0
                      ? 'не в цехе'
                      : `${batch.step} · ${ROUTE_STEPS[batch.step - 1]?.areaName ?? '—'}`}
                  </td>
                  <td className={STATUS_CLASS[batch.status]}>{STATUS_WORD[batch.status]}</td>
                  <td>{batch.waitedMinutes > 0 ? `${Math.round(batch.waitedMinutes)} мин` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="game-foot">
        <span className="ink-faint">
          Времена модельные. Смена — {span.shiftMinutes} минут. Цех показан как движение по следу; правда смены открывается в разборе.
        </span>
      </footer>
    </div>
  );
}
