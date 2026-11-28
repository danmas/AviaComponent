/**
 * Разбор одной смены: запись журнала, факт цеха и вердикт.
 * Цех запрашивается только здесь и только на открытую смену.
 * Баллов и отдельного счётчика совпадений нет.
 */
import { useEffect, useState } from 'react';

import { client } from '../lib/api.ts';
import { decisionsInShift } from '../lib/decisions.ts';
import type { ScreenParams } from '../lib/params.ts';
import {
  dueLines,
  issuedMetrics,
  loadReview,
  recordsOf,
  reviewDecisions,
  shopOf,
  type DecisionReview,
  type DueLine,
  type ReviewLoad,
} from '../lib/review.ts';
import type { PlayState, ScreenId } from '../lib/session.ts';
import { ScreenTabs } from './ScreenTabs.tsx';

interface ShellProps {
  readonly play: PlayState;
  readonly params: ScreenParams;
  readonly onScreen: (screen: ScreenId) => void;
  readonly onStep: () => Promise<void>;
  readonly onView: (shift: number) => void;
}

export function ReviewScreen(props: ShellProps): JSX.Element {
  const { play, params } = props;
  const [load, setLoad] = useState<ReviewLoad | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const next = await loadReview(client, play.sessionId, play.viewShift);
        if (!alive) {
          return;
        }
        setLoad(next);
        setError(null);
        setLoading(false);
      } catch (caught: unknown) {
        if (alive) {
          setLoading(false);
          setError(caught instanceof Error ? caught.message : 'Разбор недоступен');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [play.sessionId, play.viewShift]);

  const shop = load === null ? null : shopOf(load.shop);
  const roles = load === null ? [] : recordsOf(load.roles);
  const decisions: readonly DecisionReview[] = load === null || shop === null
    ? []
    : reviewDecisions({
      journal: decisionsInShift(load.session.decisionJournal, play.viewShift),
      shop,
      roles,
      metrics: issuedMetrics(load.session.summary),
    });
  const dues: readonly DueLine[] = shop === null ? [] : dueLines(roles, shop);
  const ready = load !== null && !loading;

  return (
    <div className="sheet" data-screen="review" data-ready={ready ? 'true' : 'false'}>
      <header className="sheet-head">
        <div>
          <ScreenTabs screen="review" onScreen={props.onScreen} />
          <h1>Разбор</h1>
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
      {!ready || shop === null ? <p>Считаем разбор…</p> : (
        <>
          <p className="fact-mark" data-fact="true">
            Это факт. Цех смены {shop.shift} — то, что было на самом деле.
          </p>

          <section data-block="decisions">
            <h2>Решения</h2>
            {decisions.length === 0 ? <p>Решений на этой смене нет.</p> : (
              <table>
                <thead>
                  <tr>
                    <th>Запись</th>
                    <th>Основание</th>
                    <th>Покрытие</th>
                    <th>Факт</th>
                    <th>Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((row) => (
                    <tr key={`${row.at}-${row.action}`}>
                      <td data-record="true">
                        <span className="record-mark">Запись.</span>
                        <span>{row.action}</span>
                        <span className="ink-faint">{row.consequence}</span>
                      </td>
                      <td>{row.basisText}</td>
                      <td>{row.coverageLabel}</td>
                      <td data-fact="true">{row.fact}</td>
                      <td className="verdict">{row.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section data-block="dues">
            <h2>Срок и факт закрытия</h2>
            <p className="legend">
              Договорный срок — из среза ролей. Факт закрытия — минута прихода на склад из среза цеха.
              Расхождение — разница этих двух минут. Длительность маршрута не считается.
            </p>
            {dues.length === 0 ? <p>Заказов в срезе нет.</p> : (
              <table>
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Срок</th>
                    <th>Факт закрытия</th>
                    <th>Расхождение</th>
                    <th>Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {dues.map((row) => (
                    <tr key={row.orderId} data-order={row.orderId}>
                      <td>{row.orderId}</td>
                      <td>{row.dueLabel}</td>
                      <td>{row.closeLabel}</td>
                      <td>{row.gapLabel}</td>
                      <td className="verdict">{row.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
