/**
 * Экран цеха: маршрут участков, место партий, очереди, простои, движение.
 * Мощность и очередь не считает: берёт срез `shop`. Неразобранные заказы
 * читает из среза ролей и отдаёт два решения — принять или отложить.
 *
 * Начальное состояние берётся из адреса (`?shift=3&mode=movement`), чтобы
 * снимок экрана был воспроизводим: одна ссылка — одно состояние.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ShopResponse } from '../../../api-client/types.ts';
import { client } from '../lib/api.ts';
import { pendingOrders, type PendingOrder } from '../lib/orders.ts';
import { areasOf, arrivalText, chargeText, movementBetween, progressText, statusCounts, tracksOf } from '../lib/shop.ts';
import { downtimeText, missingLine, STATUS_TEXT } from '../lib/missing.ts';
import type { ScreenParams } from '../lib/params.ts';
import { flowOf, hoursOf, waitMinutes } from '../lib/flow.ts';
import type { PlayState, ScreenId } from '../lib/session.ts';
import { waitingOf, waitingText } from '../lib/waiting.ts';
import { RouteFlow } from './RouteFlow.tsx';
import { ScreenTabs } from './ScreenTabs.tsx';

export type Shop = ShopResponse['reality'];

interface LocalState {
  readonly shop: Shop | null;
  readonly orders: readonly PendingOrder[];
  readonly error: string | null;
  readonly previous: Shop | null;
  readonly loading: boolean;
  readonly mode: 'now' | 'movement';
}

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

export function ShopScreen(props: {
  readonly play: PlayState;
  readonly params: ScreenParams;
  readonly onScreen: (screen: ScreenId) => void;
  readonly onStep: () => Promise<void>;
  readonly onView: (shift: number) => void;
}): JSX.Element {
  const { play, params } = props;
  const [state, setState] = useState<LocalState>({
    shop: null,
    orders: [],
    error: null,
    previous: null,
    loading: true,
    mode: params.mode,
  });
  const nav = useRef<'sync' | 'step' | 'past'>('sync');
  const lastShop = useRef<Shop | null>(null);

  useEffect(() => {
    let alive = true;
    const kind = nav.current;
    nav.current = 'sync';
    const carried = lastShop.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    void (async () => {
      try {
        const now = await client.shop(play.sessionId, play.viewShift);
        const orders = await ordersAt(play.sessionId, play.viewShift);
        let previous: Shop | null = null;
        if (kind === 'step' && state.mode === 'movement') {
          previous = carried;
        } else if (kind === 'past') {
          previous = null;
        } else if (state.mode === 'movement' && play.viewShift > 0) {
          const before = await client.shop(play.sessionId, play.viewShift - 1);
          previous = before.reality;
        }
        if (!alive) {
          return;
        }
        lastShop.current = now.reality;
        setState((current) => ({
          ...current,
          shop: now.reality,
          orders,
          previous,
          loading: false,
          error: null,
        }));
      } catch (error: unknown) {
        if (alive) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : 'Сервер недоступен',
          }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [play.sessionId, play.viewShift, state.mode]);

  async function step(): Promise<void> {
    nav.current = 'step';
    try {
      await props.onStep();
    } catch (error: unknown) {
      nav.current = 'sync';
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Шаг смены отклонён',
      }));
    }
  }

  function loadPast(): void {
    nav.current = 'past';
    props.onView(play.viewShift - 1);
  }

  async function choose(orderId: string, type: 'accept-order' | 'defer-order'): Promise<void> {
    try {
      await client.decide(play.sessionId, { type, orderId });
      const [shop, orders] = await Promise.all([
        client.shop(play.sessionId, play.viewShift),
        ordersAt(play.sessionId, play.viewShift),
      ]);
      lastShop.current = shop.reality;
      setState((current) => ({ ...current, shop: shop.reality, orders, error: null }));
    } catch (error: unknown) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Решение отклонено',
      }));
    }
  }

  function toggleMode(): void {
    setState((current) => ({
      ...current,
      mode: current.mode === 'now' ? 'movement' : 'now',
      previous: current.mode === 'now' ? current.previous : null,
    }));
  }

  const areas = useMemo(() => (state.shop === null ? [] : areasOf(state.shop)), [state.shop]);
  const tracks = useMemo(() => (state.shop === null ? [] : tracksOf(state.shop)), [state.shop]);
  const counts = useMemo(() => (state.shop === null ? null : statusCounts(state.shop)), [state.shop]);
  const changes = useMemo(
    () => (state.shop === null || state.previous === null ? [] : movementBetween(state.previous, state.shop)),
    [state.shop, state.previous],
  );
  const flow = useMemo(() => (state.shop === null ? null : flowOf(state.shop)), [state.shop]);

  const ready = state.shop !== null && counts !== null && !state.loading;

  return (
    <div className="sheet" data-screen="shop" data-ready={ready ? 'true' : 'false'}>
      <header className="sheet-head">
        <div>
          <ScreenTabs screen="shop" onScreen={props.onScreen} />
          <h1>Цех</h1>
          <p className="sub">
            смена {play.viewShift} из {play.shiftCount - 1}
            {state.shop !== null ? ` · ${minutesText(state.shop.now)}` : ''}
          </p>
          <p className="sub">
            уровень {params.level} · помеха {params.overlay} · seed {params.seed}
          </p>
        </div>
        <div className="controls">
          <a
            className="alt-link"
            href={`http://127.0.0.1:8766/?shift=${play.viewShift}&level=${params.level}&overlay=${params.overlay}&seed=${params.seed}`}
          >
            холст
          </a>
          <button type="button" onClick={() => void step()} disabled={play.serverShift >= play.shiftCount - 1}>
            следующая смена
          </button>
          <button type="button" className={state.mode === 'movement' ? 'active' : ''} onClick={toggleMode}>
            {state.mode === 'movement' ? 'движение вкл' : 'движение'}
          </button>
          {play.viewShift > 0 ? (
            <button type="button" onClick={loadPast}>
              смена −1
            </button>
          ) : null}
        </div>
      </header>

      {state.error !== null ? <p className="error">{state.error}</p> : null}
      {!ready ? (
        <p>
          {state.error !== null && state.shop === null
            ? 'Запустите сервер с источниками UI: npm run api:ui в каталоге SIM, порт 3400.'
            : 'Считаем срез…'}
        </p>
      ) : null}

      {ready && counts !== null && state.shop !== null ? <>
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
      </> : null}
    </div>
  );
}
