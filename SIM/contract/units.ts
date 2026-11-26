export const UNIT_KINDS = [
  'norm-hour',
  'machine-hour',
  'person-hour',
  'furnace-hour',
  'charge-day',
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number];

/**
 * Параметр единицы инвариантен: Quantity<'norm-hour'> нельзя подставить
 * туда, где ждут Quantity<'machine-hour'>, и наоборот.
 * Поле символа не существует в значении, в отчёт оно не попадает.
 */
declare const unitInvariant: unique symbol;

export type Quantity<K extends UnitKind> = {
  readonly kind: K;
  readonly amount: number;
} & {
  readonly [unitInvariant]: (value: K) => K;
};

/** Количество, у которого единица известна в момент чтения, но не в типе поля. */
export type AnyQuantity = { [K in UnitKind]: Quantity<K> }[UnitKind];

export function quantity<K extends UnitKind>(kind: K, amount: number): Quantity<K> {
  if (!Number.isFinite(amount)) {
    throw new Error(`Количество единицы «${kind}» должно быть конечным числом.`);
  }
  return { kind, amount } as Quantity<K>;
}

/** Складывает только одинаковые единицы. Разные единицы не проходят проверку типов. */
export function add<K extends UnitKind>(left: Quantity<K>, right: Quantity<K>): Quantity<K> {
  if (left.kind !== right.kind) {
    throw new Error(`Нельзя сложить «${left.kind}» и «${right.kind}».`);
  }
  return { kind: left.kind, amount: left.amount + right.amount } as Quantity<K>;
}

export interface ConversionBasis<From extends UnitKind, To extends UnitKind> {
  readonly id: string;
  readonly from: From;
  readonly to: To;
  /** Сколько единиц `to` приходится на одну единицу `from`. */
  readonly factor: number;
  /** Откуда взято основание. Без этой записи перевод не выполняется. */
  readonly sourceNote: string;
}

export interface Converted<From extends UnitKind, To extends UnitKind> {
  readonly value: Quantity<To>;
  readonly basis: ConversionBasis<From, To>;
}

export function convert<From extends UnitKind, To extends UnitKind>(
  value: Quantity<From>,
  basis: ConversionBasis<From, To>,
): Converted<From, To> {
  if (basis.from !== value.kind) {
    throw new Error('Основание перевода не совпадает с единицей значения.');
  }
  if ((basis.from as UnitKind) === basis.to) {
    throw new Error('Перевод в ту же единицу не записывается как перевод.');
  }
  if (!Number.isFinite(basis.factor) || basis.factor <= 0) {
    throw new Error('Множитель основания должен быть конечным и больше нуля.');
  }
  if (basis.id.trim().length === 0 || basis.sourceNote.trim().length === 0) {
    throw new Error('Перевод требует идентификатор основания и пометку источника.');
  }
  return {
    value: { kind: basis.to, amount: value.amount * basis.factor } as Quantity<To>,
    basis,
  };
}
