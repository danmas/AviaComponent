/**
 * Раскладка среза свода в подписи. Арифметики нет: числа копируются из ответа.
 * Покрытие в вес переводится только через coverage.ts.
 */
import type { RolesResponse, SessionResponse } from '../../../api-client/types.ts';

import { coverageText, coverageWeight, type CoverageWeight } from './coverage.ts';
import { pendingOrders } from './orders.ts';

export const METRIC_ORDER = ['portfolio', 'overload', 'acceptedShift', 'scheduleRisk'] as const;
export type MetricId = (typeof METRIC_ORDER)[number];

export const METRIC_TITLE: Record<MetricId, string> = {
  portfolio: 'портфель',
  overload: 'перегрузка',
  acceptedShift: 'принято за смену',
  scheduleRisk: 'риск сроков',
};

const UNIT_LABEL: Record<string, string> = {
  'norm-hour': 'н/ч',
  'machine-hour': 'станко-ч',
  'person-hour': 'чел-ч',
  'furnace-hour': 'печь-ч',
  'charge-day': 'сутки садки',
};

export type Summary = SessionResponse['summary'];

export interface MetricView {
  readonly id: MetricId;
  readonly title: string;
  readonly coverage: number;
  readonly coverageLabel: string;
  readonly weight: CoverageWeight;
  /** Полное покрытие приглушается: скрыть его — прочитать как «показателя нет». */
  readonly quiet: boolean;
  readonly valueText: string;
  readonly reads: readonly string[];
  readonly change: string | null;
}

export interface RegistryRow {
  readonly id: string;
  readonly title: string;
  readonly coverage: number;
  readonly coverageLabel: string;
  readonly weight: CoverageWeight;
  readonly change: string | null;
}

export interface AreaView {
  readonly areaId: string;
  readonly areaName: string;
  readonly capacityAmount: number;
  readonly planAmount: number;
  readonly queueAmount: number;
  readonly capacityText: string;
  readonly planText: string;
  readonly queueText: string;
}

/** Реестр выше значений. Экран рисует блоки в этом порядке. */
export const DASHBOARD_BLOCKS = ['reliability', 'metrics', 'areas', 'decisions', 'journal'] as const;

function isMetricId(value: string): value is MetricId {
  return (METRIC_ORDER as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

export function unitLabel(kind: string): string {
  return UNIT_LABEL[kind] ?? kind;
}

function quantityText(kind: string, amount: number): string {
  return `${amount} ${unitLabel(kind)}`;
}

export function valueText(metricId: string, value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  if (metricId === 'portfolio') {
    const openCount = numberField(value, 'openCount');
    const remainder = numberField(value, 'remainderNormHours');
    const withoutNorm = numberField(value, 'ordersWithoutNorm');
    if (openCount === null || remainder === null || withoutNorm === null) {
      return '';
    }
    return `открыто ${openCount}, остаток ${remainder} н/ч, без нормы ${withoutNorm}`;
  }
  if (metricId === 'overload') {
    const overloaded = numberField(value, 'overloadedCount');
    const areas = value['areas'];
    if (overloaded === null || !Array.isArray(areas)) {
      return '';
    }
    return `участков ${areas.length}, в перегрузке ${overloaded}`;
  }
  if (metricId === 'acceptedShift') {
    const normHours = numberField(value, 'normHours');
    const master = numberField(value, 'masterCloses');
    const worker = numberField(value, 'workerCloses');
    if (normHours === null || master === null || worker === null) {
      return '';
    }
    return `${normHours} н/ч, мастер ${master}, рабочий ${worker}`;
  }
  if (metricId === 'scheduleRisk') {
    const overdue = numberField(value, 'overdue');
    const onTime = numberField(value, 'onTime');
    const unevaluated = numberField(value, 'unevaluated');
    if (overdue === null || onTime === null || unevaluated === null) {
      return '';
    }
    return `просрочено ${overdue}, в срок ${onTime}, без оценки ${unevaluated}`;
  }
  return '';
}

export function formatBasisValue(metricId: string, raw: string): string {
  try {
    return valueText(metricId, JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
}

function deltaText(previous: number, current: number): string {
  const delta = Math.round((previous - current) * 1000) / 1000;
  return String(delta);
}

/**
 * Падение покрытия против прошлого среза.
 * Причина — только неразобранные заказы из среза ролей, и только у портфеля.
 * Иначе фраза «покрытие снизилось» без выдуманного объяснения.
 * Первый срез (прошлого нет) — null.
 */
export function coverageChange(input: {
  readonly metricId: string;
  readonly previous: number | null;
  readonly current: number;
  readonly unparsedIds: readonly string[];
}): string | null {
  if (input.previous === null || !(input.current < input.previous)) {
    return null;
  }
  const head = `покрытие ${coverageText(input.current)} (было ${coverageText(input.previous)}, −${deltaText(input.previous, input.current)})`;
  if (input.metricId === 'portfolio' && input.unparsedIds.length > 0) {
    const noun = input.unparsedIds.length === 1 ? 'неразобранный заказ' : 'неразобранные заказы';
    return `Покрытие ${coverageText(input.current)} (было ${coverageText(input.previous)}, −${deltaText(input.previous, input.current)}: ${noun} ${input.unparsedIds.join(', ')})`;
  }
  return `покрытие снизилось: ${head}`;
}

function metricOf(summary: Summary, id: MetricId): { coverage: number; value: unknown; reads: readonly string[] } {
  const row = summary.metrics[id];
  return { coverage: row.coverage, value: row.value, reads: row.reads };
}

export function metricViews(current: Summary, previous: Summary | null, roles: RolesResponse): readonly MetricView[] {
  const unparsedIds = pendingOrders(roles).map((order) => order.id);
  return METRIC_ORDER.map((id) => {
    const row = metricOf(current, id);
    const prior = previous === null ? null : metricOf(previous, id).coverage;
    const change = coverageChange({ metricId: id, previous: prior, current: row.coverage, unparsedIds });
    return {
      id,
      title: METRIC_TITLE[id],
      coverage: row.coverage,
      coverageLabel: `покрытие ${coverageText(row.coverage)}`,
      weight: coverageWeight(row.coverage),
      quiet: change === null && row.coverage >= 1,
      valueText: valueText(id, row.value),
      reads: row.reads,
      change,
    };
  });
}

export function registryRows(current: Summary, previous: Summary | null, roles: RolesResponse): readonly RegistryRow[] {
  const changes = new Map(metricViews(current, previous, roles).map((row) => [row.id, row.change]));
  return current.reliability.map((row) => {
    const title = isMetricId(row.id) ? METRIC_TITLE[row.id] : row.id;
    return {
      id: row.id,
      title,
      coverage: row.coverage,
      coverageLabel: `покрытие ${coverageText(row.coverage)}`,
      weight: coverageWeight(row.coverage),
      change: changes.get(row.id as MetricId) ?? null,
    };
  });
}

export function areaViews(summary: Summary): readonly AreaView[] {
  return summary.areas.map((area) => ({
    areaId: area.areaId,
    areaName: area.areaName,
    capacityAmount: area.capacity.amount,
    planAmount: area.plan.amount,
    queueAmount: area.queue.amount,
    capacityText: quantityText(area.capacity.kind, area.capacity.amount),
    planText: quantityText(area.plan.kind, area.plan.amount),
    queueText: quantityText(area.queue.kind, area.queue.amount),
  }));
}
