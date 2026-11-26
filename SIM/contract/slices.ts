/**
 * Три среза видимости. Контракт не импортирует ни цех, ни Систему:
 * наполнение среза задаёт тот модуль, которому срез принадлежит.
 * Свод не несёт тип состояния цеха.
 */
export const LAYERS = ['shop', 'roles', 'summary'] as const;

export type Layer = (typeof LAYERS)[number];

export interface ShopSlice<TReality> {
  readonly layer: 'shop';
  readonly reality: TReality;
}

export interface RoleRecordsSlice<TRecord> {
  readonly layer: 'roles';
  readonly records: readonly TRecord[];
}

export interface SummarySlice<TMetrics> {
  readonly layer: 'summary';
  readonly metrics: TMetrics;
}
