/**
 * Свод руководителя: записи, не физика цеха.
 * Показатели не пересчитываются. Срез цеха не запрашивается.
 */
import { useEffect, useState } from 'react';

import type { ScreenParams } from '../lib/params.ts';
import { client } from '../lib/api.ts';
import { coverageText, coverageWeight } from '../lib/coverage.ts';
import { loadDashboard, type DashboardLoad } from '../lib/dashboard.ts';
import {
  basisOf,
  counterText,
  decisionPrice,
  decisionsInShift,
  journalViews,
  limitNote,
  type PriceView,
} from '../lib/decisions.ts';
import { areaViews, metricViews, registryRows } from '../lib/metrics.ts';
import { pendingOrders } from '../lib/orders.ts';
import type { PlayState, ScreenId } from '../lib/session.ts';
import { DecisionPanel } from './DecisionPanel.tsx';
import { ScreenTabs } from './ScreenTabs.tsx';

interface ShellProps {
  readonly play: PlayState;
  readonly params: ScreenParams;
  readonly onScreen: (screen: ScreenId) => void;
  readonly onStep: () => Promise<void>;
  readonly onView: (shift: number) => void;
}

type Draft =
  | { readonly type: 'accept-order' | 'defer-order'; readonly orderId: string }
  | { readonly type: 'priority'; readonly batchId: string; readonly rank: number };

function draftTitle(draft: Draft): string {
  if (draft.type === 'priority') {
    return `приоритет партии ${draft.batchId}: ранг ${draft.rank}`;
  }
  return draft.type === 'accept-order' ? `принять заказ ${draft.orderId}` : `отложить заказ ${draft.orderId}`;
}

export function DashboardScreen(props: ShellProps): JSX.Element {
  const { play, params } = props;
  const [load, setLoad] = useState<DashboardLoad | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [batchId, setBatchId] = useState('');
  const [rankText, setRankText] = useState('0');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const next = await loadDashboard(client, play.sessionId, play.viewShift);
        if (!alive) {
          return;
        }
        setLoad(next);
        setError(null);
        setLoading(false);
      } catch (caught: unknown) {
        if (alive) {
          setLoading(false);
          setError(caught instanceof Error ? caught.message : 'Свод недоступен');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [play.sessionId, play.viewShift]);

  const journal = load?.current.decisionJournal ?? [];
  const taken = decisionsInShift(journal, play.viewShift);
  const capped = limitNote(taken.length);
  const past = play.viewShift !== play.serverShift
    ? 'Решение пишется на текущую смену. Открыта прошлая — вернитесь на неё шагом смены.'
    : null;
  const blocked = capped ?? past;

  function openOrder(type: 'accept-order' | 'defer-order', orderId: string): void {
    if (blocked !== null) {
      return;
    }
    setDraft({ type, orderId });
  }

  function openPriority(): void {
    if (blocked !== null) {
      return;
    }
    const rank = Number(rankText);
    const id = batchId.trim();
    if (id.length === 0 || !Number.isInteger(rank)) {
      setError('Для приоритета нужны партия и целый ранг.');
      return;
    }
    setError(null);
    setDraft({ type: 'priority', batchId: id, rank });
  }

  async function apply(): Promise<void> {
    if (draft === null || blocked !== null) {
      return;
    }
    try {
      if (draft.type === 'priority') {
        await client.decide(play.sessionId, { type: draft.type, batchId: draft.batchId, rank: draft.rank });
      } else {
        await client.decide(play.sessionId, { type: draft.type, orderId: draft.orderId });
      }
      setDraft(null);
      const next = await loadDashboard(client, play.sessionId, play.viewShift);
      setLoad(next);
      setError(null);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Решение отклонено');
    }
  }

  const orders = load === null ? [] : pendingOrders(load.roles);
  const metrics = load === null ? [] : metricViews(load.current.summary, load.previous?.summary ?? null, load.roles);
  const registry = load === null ? [] : registryRows(load.current.summary, load.previous?.summary ?? null, load.roles);
  const areas = load === null ? [] : areaViews(load.current.summary);
  const journalRows = journalViews(journal);
  const price: PriceView | null = draft === null || load === null
    ? null
    : decisionPrice({
        basisMetric: basisOf(draft.type),
        basisValue: JSON.stringify(load.current.summary.metrics[basisOf(draft.type)].value),
        coverage: load.current.summary.metrics[basisOf(draft.type)].coverage,
      });

  return (
    <div className="sheet" data-screen="dashboard" data-ready={load !== null && !loading ? 'true' : 'false'}>
      <header className="sheet-head">
        <div>
          <ScreenTabs screen="dashboard" onScreen={props.onScreen} />
          <h1>Свод</h1>
          <p className="sub">смена {play.viewShift} из {play.shiftCount - 1}</p>
          <p className="sub">уровень {params.level} · помеха {params.overlay} · seed {params.seed}</p>
        </div>
        <div className="controls">
          <button type="button" onClick={() => void props.onStep()} disabled={play.serverShift >= play.shiftCount - 1}>
            следующая смена
          </button>
          {play.viewShift > 0 ? (
            <button type="button" onClick={() => props.onView(play.viewShift - 1)}>смена −1</button>
          ) : null}
        </div>
      </header>

      {error !== null ? <p className="error">{error}</p> : null}
      {loading || load === null ? <p>Считаем свод…</p> : (
        <>
          <section className="registry" data-block="reliability">
            <h2>Реестр достоверности</h2>
            <p className="legend">
              Вес числа: от 0.9 плотная тушь, от 0.6 обычная, от 0.3 пунктир, ниже контур.
              Полное покрытие приглушено — показатель на месте, с ним всё собрано.
            </p>
            <ul>
              {registry.map((row) => (
                <li key={row.id}>
                  <span>{row.title}</span>
                  <span className={`weight-${row.weight}`}>{row.coverageLabel}</span>
                  {row.change !== null ? <span className="drop">{row.change}</span> : null}
                </li>
              ))}
            </ul>
          </section>

          <section data-block="metrics">
            <h2>Показатели</h2>
            {metrics.map((metric) => (
              <article key={metric.id} className={metric.quiet ? 'metric metric-quiet' : 'metric'} data-metric={metric.id}>
                <h3>{metric.title}</h3>
                <p className={`weight-${metric.weight}`}>{metric.valueText}</p>
                <p className={`weight-${coverageWeight(metric.coverage)}`}>{metric.coverageLabel}</p>
                <p className="ink-faint">записи: {metric.reads.join(', ')}</p>
                {metric.change !== null ? <p className="drop">{metric.change}</p> : null}
              </article>
            ))}
          </section>

          <section data-block="areas">
            <h2>Мощность и очередь</h2>
            <table className="areas-table">
              <thead>
                <tr>
                  <th>участок</th>
                  <th>мощность</th>
                  <th>план</th>
                  <th>очередь</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((area) => (
                  <tr key={area.areaId}>
                    <td>{area.areaName}</td>
                    <td>{area.capacityText}</td>
                    <td>{area.planText}</td>
                    <td>{area.queueText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section data-block="decisions">
            <h2>Решения</h2>
            <p className="counter">{counterText(taken.length)}</p>
            {blocked !== null ? <p className="hint">{blocked}</p> : null}
            <section className="inbox">
            <ul>
              {orders.map((order) => (
                <li key={order.id}>
                  <span>{order.id}</span>
                  <span>{order.due === null ? 'срок не задан' : `срок ${order.due} мин`}</span>
                  <button type="button" data-decide="accept-order" data-order={order.id} disabled={blocked !== null} onClick={() => openOrder('accept-order', order.id)}>принять</button>
                  <button type="button" data-decide="defer-order" data-order={order.id} disabled={blocked !== null} onClick={() => openOrder('defer-order', order.id)}>отложить</button>
                </li>
              ))}
            </ul>
            </section>
            <div className="priority-form">
              <label>
                партия
                <input value={batchId} onChange={(event) => setBatchId(event.target.value)} />
              </label>
              <label>
                ранг
                <input value={rankText} onChange={(event) => setRankText(event.target.value)} />
              </label>
              <button type="button" data-decide="priority" disabled={blocked !== null} onClick={openPriority}>показать цену</button>
            </div>
            {draft !== null && price !== null ? (
              <DecisionPanel
                title={draftTitle(draft)}
                price={price}
                blocked={blocked}
                onCancel={() => setDraft(null)}
                onApply={() => void apply()}
              />
            ) : null}
          </section>

          <section data-block="journal">
            <h2>Журнал решений</h2>
            {journalRows.length === 0 ? <p className="ink-faint">Записей нет.</p> : (
              <ul className="journal">
                {journalRows.map((row, index) => (
                  <li key={`${row.at}-${index}`} className="journal-row">
                    <span className="journal-at">{row.at} мин</span>
                    <span className="journal-action">{row.action}</span>
                    <span className="journal-basis">основание: {row.basis}</span>
                    <span className="journal-coverage">покрытие {coverageText(row.coverage)}</span>
                    <span className="journal-consequence">{row.consequence}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

