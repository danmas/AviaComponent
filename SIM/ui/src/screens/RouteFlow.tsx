/**
 * Схема маршрута: участки связаны, на связи — сколько ждёт запуска на участке.
 * Узкое место помечено рамкой, а не цветом: цвет на экране отвечает за достоверность.
 */
import type { Flow } from '../lib/flow.ts';

export function RouteFlow(props: { readonly flow: Flow }): JSX.Element {
  const { nodes, links, bottleneckId } = props.flow;

  return (
    <section className="flow">
      <h2>Маршрут</h2>
      {bottleneckId === null ? (
        <p className="ink-faint">Очередей нет.</p>
      ) : (
        <p className="flow-note">
          узкое место: <b>{nodes.find((node) => node.id === bottleneckId)?.name ?? bottleneckId}</b>
        </p>
      )}
      <ol className="flow-chain">
        {nodes.map((node, index) => (
          <li key={node.id} className={`flow-node ${node.isBottleneck ? 'flow-bottleneck' : ''}`}>
            <div className="flow-name">{node.name}</div>
            <div className="flow-state">
              {node.running.length > 0 ? <span className="flow-run">в работе {node.running.length}</span> : null}
              {node.waiting.length > 0 ? <span className="flow-wait">ждёт {node.waiting.length}</span> : null}
              {node.running.length === 0 && node.waiting.length === 0 ? (
                <span className="flow-free">свободен</span>
              ) : null}
            </div>
            {(() => {
              const link = links[index];
              if (link === undefined) {
                return null;
              }
              return (
                <div className="flow-link" title="сколько ждёт запуска на этом участке">
                  <span className="flow-arrow">↓</span>
                  <span className="flow-count">{link.waitingCount}</span>
                </div>
              );
            })()}
          </li>
        ))}
      </ol>
    </section>
  );
}
