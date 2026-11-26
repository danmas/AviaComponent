import { transferred, type Pieces } from '../contract/quantity.ts';
import type { RouteCardOperation } from './types.ts';

/** Годные по записи карты: сделано − брак. Цех для этого не читается. */
export function recordedGood(card: RouteCardOperation): Pieces | null {
  if (card.totals === null) {
    return null;
  }
  return transferred(card.totals.done, card.totals.scrap);
}
