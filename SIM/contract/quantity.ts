declare const piecesBrand: unique symbol;

/** Штуки деталей. Не нормо-час и не станко-час. */
export type Pieces = number & { readonly [piecesBrand]: 'Pieces' };

export function pieces(value: number): Pieces {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Количество деталей — целое число штук, не меньше нуля.');
  }
  return value as Pieces;
}

/** Передача дальше = сделано − брак. Правило общего описания системы. */
export function transferred(done: Pieces, scrap: Pieces): Pieces {
  if (scrap > done) {
    throw new Error('Брак не может превышать сделанное.');
  }
  return pieces(done - scrap);
}

/**
 * Три основания отрывной карты из глоссария.
 * Уменьшение родителя не делается только для ведомости дефекта.
 * Для «создания партии» и «ручного отрыва» уменьшение следует из этой оговорки.
 */
export type TearOffGround = 'batch-create' | 'defect-sheet' | 'manual';

export interface TearOffResult {
  readonly ground: TearOffGround;
  readonly parentQty: Pieces;
  readonly childQty: Pieces;
  /**
   * false — потомок уже входит в количество родителя, отдельно не суммируется.
   * Так отрыв по ведомости не удваивает учёт.
   */
  readonly childCountsApart: boolean;
}

export function applyTearOff(parentQty: Pieces, childQty: Pieces, ground: TearOffGround): TearOffResult {
  if (childQty <= 0) {
    throw new Error('Отрыв пустой части не выполняется.');
  }
  if (childQty > parentQty) {
    throw new Error('Отрыв больше количества родителя.');
  }
  if (ground === 'defect-sheet') {
    return { ground, parentQty, childQty, childCountsApart: false };
  }
  return {
    ground,
    parentQty: pieces(parentQty - childQty),
    childQty,
    childCountsApart: true,
  };
}

export function summedPieces(
  batches: readonly { readonly qty: Pieces; readonly countsApart: boolean }[],
): number {
  return batches.reduce((sum, batch) => sum + (batch.countsApart ? batch.qty : 0), 0);
}
