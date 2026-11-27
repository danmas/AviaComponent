/**
 * Экран цеха: маршрут участков, место партий, очереди, простои, движение.
 * Мощность и очередь не считает: берёт срез `shop`. Неразобранные заказы
 * читает из среза ролей и отдаёт два решения — принять или отложить.
 *
 * Начальное состояние берётся из адреса (`?shift=3&mode=movement`), чтобы
 * снимок экрана был воспроизводим: одна ссылка — одно состояние.
 */
import { useEffect, useMemo, useState } from 'react';

import type { ShopResponse } from '../../../api-client/types.ts';
import { createClient } from '../../../api-client/client.ts';
import { pendingOrders, type PendingOrder } from '../lib/orders.ts';
import { areasOf, arrivalText, chargeText, movementBetween, progressText, statusCounts, tracksOf } from '../lib/shop.ts';
import { downtimeText, missingLine, STATUS_TEXT } from '../lib/missing.ts';
import { screenParams } from '../lib/params.ts';
import { flowOf, hoursOf, waitMinutes } from '../lib/flow.ts';
import { waitingOf, waitingText } from '../lib/waiting.ts';
import { RouteFlow } from './RouteFlow.tsx';

// В сборке экран и API живут на одном хосте: адрес берётся из страницы.
// В разработке Vite на 5173, а сервер на 3400 — тогда задаётся VITE_API_BASE.
const API_BASE = import.meta.env['VITE_API_BASE'] ?? (globalThis.location?.origin ?? 'http://127.0.0.1:3400');
const client = createClient({ baseUrl: API_BASE });

export type Shop = ShopResponse['reality'];

interface ScreenState {
  readonly sessionId: string | null;
  readonly shift: number;
  readonly shop: Shop | null;
  readonly orders: readonly PendingOrder[];
  readonly shiftCount: number;
  readonly error: string | null;
  readonly previous: Shop | null;
  readonly loading: boolean;
  readonly mode: 'now' | 'movement';
}

const START = screenParams();

const EMPTY: ScreenState = {
  sessionId: null,
  shift: 0,
  shop: null,
  orders: [],
  shiftCount: 12,
  error: null,
  previous: null,
  loading: true,
  mode: START.mode,
};

function minutesText(minutes: number): string {
  const shift = Math.floor(minutes / 720);
  const rest = minutes % 720;
  return `${minutes} мин · смена ${shift}${rest === 0 ? '' : ` +${rest}`}`;
}

function OperationLine(props: {
  readonly title: string;
  readonly status: string;
  readonly done: number;
  readonly planned: number;
  readonly scrap: number;
  readonly reason?: string;
  readonly resource?: string | null;
}): JSX.Element {
  const tone = props.status === 'running' ? 'ink-full' : props.status === 'ready' ? 'ink-dashed' : 'ink-faint';
  return (
    <div className={`op-line ${tone}`}>
      <span className="op-batch">{props.title}</span>
      <span className="op-resource">{props.resource ?? '—'}</span>
      <span className="op-status">{STATUS_TEXT[props.status as keyof typeof STATUS_TEXT] ?? props.status}</span>
      <span className="op-count">
        {progressText(props.done, props.planned, props.scrap)}
        {props.scrap > 0 ? ` · брак ${props.scrap}` : ''}
      </span>
      {props.reason !== undefined && props.reason !== '' ? <span className="op-reason">{props.reason}</span> : null}
    </div>
  );
}

async function ordersAt(sessionId: string, shift: number): Promise<readonly PendingOrder[]> {
  const roles = await client.roles(sessionId, shift);
  return pendingOrders(roles);
}

/** Доводит сессию до нужной смены шагами: срез существует только для пройденных смен. */
async function reachShift(sessionId: string, target: number): Promise<number> {
  let current = 0;
  for (let step = 0; step < target; step += 1) {
    const advanced = await client.advance(sessionId);
    current = advanced.currentShift;
  }
  return current;
}

export function ShopScreen(): JSX.Element {
  const [state, setState] = useState<ScreenState>(EMPTY);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const created = await client.createSession({
          seed: START.seed,
          level: START.level,
          overlay: START.overlay,
        });
        const reached = await reachShift(created.id, START.shift);
        const [now, before, orders] = START.mode === 'movement' && reached > 0
          ? await Promise.all([
              client.shop(created.id, reached),
              client.shop(created.id, reached - 1),
              ordersAt(created.id, reached),
            ])
          : [await client.shop(created.id, reached), null, await ordersAt(created.id, reached)] as const;
        if (!alive) {
          return;
        }
        setState({
          sessionId: created.id,
          shift: reached,
          shop: now.reality,
          orders,
          shiftCount: created.horizonShifts,
          error: null,
          previous: before === null ? null : before.reality,
          loading: false,
          mode: START.mode,
        });
      } catch (error: unknown) {
        if (alive) {
          setState({
            ...EMPTY,
            loading: false,
            error: error instanceof Error ? error.message : 'Сервер недоступен',
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function step(): Promise<void> {
    if (state.sessionId === null || state.shop === null) {
      return;
    }
    try {
      const advanced = await client.advance(state.sessionId);
      const [shop, orders] = await Promise.all([
        client.shop(state.sessionId),
        ordersAt(state.sessionId, advanced.currentShift),
      ]);
      setState({
        ...state,
        shift: advanced.currentShift,
        shop: shop.reality,
        orders,
        previous: state.mode === 'movement' ? state.shop : null,
        error: null,
      });
    } catch (error: unknown) {
      setState({ ...state, error: error instanceof Error ? error.message : 'Шаг смены отклонён' });
    }
  }

  async function loadPast(target: number): Promise<void> {
    if (state.sessionId === null) {
      return;
    }
    try {
      const [shop, orders] = await Promise.all([
        client.shop(state.sessionId, target),
        ordersAt(state.sessionId, target),
      ]);
      setState({ ...state, shop: shop.reality, orders, shift: target, previous: null, error: null });
    } catch (error: unknown) {
      setState({ ...state, error: error instanceof Error ? error.message : `Срез смены ${target} не выдан` });
    }
  }

  async function choose(orderId: string, type: 'accept-order' | 'defer-order'): Promise<void> {
    if (state.sessionId === null) {
      return;
    }
    try {
      await client.decide(state.sessionId, { type, orderId });
      const [shop, orders] = await Promise.all([
        client.shop(state.sessionId, state.shift),
        ordersAt(state.sessionId, state.shift),
      ]);
      setState({ ...state, shop: shop.reality, orders, error: null });
    } catch (error: unknown) {
      setState({ ...state, error: error instanceof Error ? error.message : 'Решение отклонено' });
    }
  }

  function toggleMode(): void {
    const next = state.mode === 'now' ? 'movement' : 'now';
    setState({
      ...state,
      mode: next,
      previous: next === 'movement' && state.shift > 0 && state.sessionId !== null ? state.previous : null,
    });
    if (next === 'movement' && state.previous === null && state.sessionId !== null && state.shift > 0) {
      void (async () => {
        try {
          const before = await client.shop(state.sessionId as string, state.shift - 1);
          setState((current) => ({ ...current, previous: before.reality }));
        } catch {
          // Прошлый срез недоступен — блок движения покажет подсказку.
        }
      })();
    }
  }

  const areas = useMemo(() => (state.shop === null ? [] : areasOf(state.shop)), [state.shop]);
  const tracks = useMemo(() => (state.shop === null ? [] : tracksOf(state.shop)), [state.shop]);
  const counts = useMemo(() => (state.shop === null ? null : statusCounts(state.shop)), [state.shop]);
  const changes = useMemo(
    () => (state.shop === null || state.previous === null ? [] : movementBetween(state.previous, state.shop)),
    [state.shop, state.previous],
  );
  const flow = useMemo(() => (state.shop === null ? null : flowOf(state.shop)), [state.shop]);

  if (state.loading) {
    return <div className="sheet">Считаем срез…</div>;
  }

  if (state.error !== null && state.shop === null) {
    return (
      <div className="sheet">
        <h1>Цех недоступен</h1>
        <p className="ink-faint">{state.error}</p>
        <p className="hint">
          Запустите сервер с источниками UI: <code>npm run api:ui</code> в каталоге <code>SIM</code>, порт 3400.
        </p>
      </div>
    );
  }

  if (state.shop === null || counts === null) {
    return <div className="sheet">Срез не получен.</div>;
  }

  return (
    <div className="sheet" data-ready="true">
      <header className="sheet-head">
        <div>
          <h1>Цех</h1>
          <p className="sub">
            смена {state.shift} из {state.shiftCount - 1} · {minutesText(state.shop.now)}
          </p>
          <p className="sub">
            уровень {START.level} · помеха {START.overlay} · seed {START.seed}
          </p>
        </div>
        <div className="controls">
          <button type="button" onClick={() => void step()} disabled={state.shift >= state.shiftCount - 1}>
            следующая смена
          </button>
          <button type="button" className={state.mode === 'movement' ? 'active' : ''} onClick={toggleMode}>
            {state.mode === 'movement' ? 'движение вкл' : 'движение'}
          </button>
          {state.shift > 0 ? (
            <button type="button" onClick={() => void loadPast(state.shift - 1)}>
              смена −1
            </button>
          ) : null}
        </div>
      </header>

      {state.error !== null ? <p className="error">{state.error}</p> : null}

      <section className="counts">
        <span>не готово: <b>{counts['not-ready']}</b></span>
        <span>ждёт: <b>{counts['ready']}</b></span>
        <span>в работе: <b>{counts['running']}</b></span>
        <span>закрыто: <b>{counts['done']}</b></span>
      </section>

      {flow !== null ? <RouteFlow flow={flow} /> : null}

      <section className="route">
        {areas.map((area) => (
          <article key={area.id} className={`area ${area.idle ? 'area-idle' : ''}`}>
            <h2>
              {area.name}
              <span className="area-kind">{area.kind === 'warehouse' ? 'склад' : area.resources.map((r) => r.kind).join(', ')}</span>
            </h2>

            {area.resources.map((resource) => {
              const line = chargeText(resource.chargePieces, area.running);
              return line === null ? null : (
                <div key={resource.id} className="charge">
                  садка: {line}
                </div>
              );
            })}

            {area.down.length > 0 ? (
              <div className="down">
                {area.down.map((downtime) => (
                  <div key={downtime.id}>
                    простой: {downtimeText(downtime.reason)} · {downtime.from}→{downtime.until === null ? 'сейчас' : downtime.until}
                  </div>
                ))}
              </div>
            ) : null}

            {area.running.length > 0 ? (
              <div className="group">
                <div className="group-title">в работе</div>
                {area.running.map((operation) => (
                  <OperationLine
                    key={operation.id}
                    title={`${operation.batchId} · шаг ${operation.sequence}`}
                    status={operation.status}
                    done={operation.done}
                    planned={operation.planned}
                    scrap={operation.scrap}
                    resource={operation.resourceId}
                  />
                ))}
              </div>
            ) : null}

            {area.waiting.length > 0 ? (
              <div className="group">
                <div className="group-title">очередь: {area.waiting.length}</div>
                {area.waiting.map((operation) => (
                  <div key={operation.id}>
                    <OperationLine
                      title={`${operation.batchId} · шаг ${operation.sequence}`}
                      status={operation.status}
                      done={operation.done}
                      planned={operation.planned}
                      scrap={operation.scrap}
                    />
                    <span className="op-wait">
                      {waitingText(
                        waitingOf({
                          status: operation.status,
                          readyAt: operation.readyAt ?? null,
                          startedAt: operation.startedAt ?? null,
                          now: state.shop?.now ?? 0,
                        }),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {area.idle ? <div className="group-title">свободен</div> : null}
            {area.finished.length > 0 ? (
              <div className="group-title">закрыто здесь: {area.finished.length}</div>
            ) : null}
          </article>
        ))}
      </section>

      {state.orders.length > 0 ? (
        <section className="inbox">
          <h2>Неразобранные заказы</h2>
          <ul>
            {state.orders.map((order) => (
              <li key={order.id}>
                <span>{order.id}</span>
                <span>{order.due === null ? 'срок не задан' : `срок ${order.due} мин`}</span>
                <button type="button" onClick={() => void choose(order.id, 'accept-order')}>принять</button>
                <button type="button" onClick={() => void choose(order.id, 'defer-order')}>отложить</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="tracks">
        <h2>Партии по маршруту</h2>
        <table>
          <thead>
            <tr>
              <th>партия</th>
              <th>появление</th>
              <th>штук</th>
              <th>пройдено</th>
              <th>сейчас</th>
              <th>ожидание</th>
              <th>причина</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track) => (
              <tr key={track.batch.id}>
                <td>{track.batch.id}</td>
                <td className={arrivalText(track.batch) === '' ? '' : 'batch-new'}>{arrivalText(track.batch)}</td>
                <td>{track.batch.qty}</td>
                <td>
                  {track.doneCount}/{track.totalCount}
                </td>
                <td>
                  {track.current === null
                    ? 'маршрут пройден'
                    : `${track.current.areaName} · шаг ${track.current.operation.sequence} · ${STATUS_TEXT[track.current.operation.status as keyof typeof STATUS_TEXT] ?? track.current.operation.status}`}
                </td>
                <td className="wait">
                  {track.current === null
                    ? ''
                    : waitingText(
                        waitingOf({
                          status: track.current.operation.status,
                          readyAt: track.current.operation.readyAt ?? null,
                          startedAt: track.current.operation.startedAt ?? null,
                          now: state.shop?.now ?? 0,
                        }),
                      )}
                </td>
                <td className="reason">
                  {track.current === null
                    ? ''
                    : missingLine(track.current.operation.missing) ||
                      (track.batch.materialReady ? '' : 'нет материала') ||
                      (track.batch.designDocReady ? '' : 'нет КД')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {state.mode === 'movement' ? (
        <section className="movement">
          <h2>Движение за смену</h2>
          {state.previous === null ? (
            <p className="ink-faint">Прошлый срез не загружен.</p>
          ) : changes.length === 0 ? (
            <p className="ink-faint">Изменений нет.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>партия</th>
                  <th>участок</th>
                  <th>было</th>
                  <th>стало</th>
                  <th>счёт</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.operationId}>
                    <td>{change.batchId}</td>
                    <td>{change.areaId}</td>
                    <td>{STATUS_TEXT[change.fromStatus] ?? change.fromStatus}</td>
                    <td>{STATUS_TEXT[change.toStatus] ?? change.toStatus}</td>
                    <td>
                      {change.fromDone}→{change.toDone}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </div>
  );
}
