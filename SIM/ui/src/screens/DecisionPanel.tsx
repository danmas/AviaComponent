import type { PriceView } from '../lib/decisions.ts';
import { coverageWeight } from '../lib/coverage.ts';

/**
 * Цена решения до подтверждения. Тексты приходят готовыми:
 * панель их не сочиняет и не оценивает.
 */
export function DecisionPanel(props: {
  readonly title: string;
  readonly price: PriceView;
  readonly blocked: string | null;
  readonly onCancel: () => void;
  readonly onApply: () => void;
}): JSX.Element {
  const weight = coverageWeight(props.price.coverage);
  return (
    <section className="price" data-price="open">
      <h3>{props.title}</h3>
      <p>
        основание: {props.price.basisTitle}
        {props.price.valueText === '' ? '' : ` — ${props.price.valueText}`}
      </p>
      <p className={`weight-${weight}`}>{props.price.coverageLabel}</p>
      <div className="price-rule" />
      <p data-consequence="true">{props.price.consequence}</p>
      {props.blocked !== null ? <p className="hint">{props.blocked}</p> : null}
      <div className="controls">
        <button type="button" onClick={props.onCancel}>отмена</button>
        <button type="button" onClick={props.onApply} disabled={props.blocked !== null}>применить</button>
      </div>
    </section>
  );
}
