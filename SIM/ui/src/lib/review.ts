/**
 * Разбор смены. Вердикт сравнивает два уже посчитанных факта:
 * записанное последствие и то, что лежит в срезе.
 * Очередь, пролёживание и годность здесь не считаются.
 * Приоритет сверяется с выданным срезом: второго прогона «без ранга» нет.
 */
import type { RolesResponse, SessionResponse, ShopResponse } from '../../../api-client/types.ts';

import { coverageText } from './coverage.ts';
import { SHIFT_MINUTES } from './decisions.ts';
import { formatBasisValue, METRIC_ORDER, valueText } from './metrics.ts';

export type VerdictText = 'подтвердилось' | 'разошлось' | 'невозможно проверить';

export interface JournalEntry {
  readonly at: number;
  readonly action: string;
  readonly basisMetric: string;
  readonly basisValue: string;
  readonly coverage: number;
  readonly consequence: string;
}

export interface ReviewOperation {
  readonly id: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly status: string;
  readonly readyAt: number | null;
}

export interface ReviewShop {
  readonly shift: number;
  readonly warehouseAreaIds: readonly string[];
  readonly operations: readonly ReviewOperation[];
}

export interface ReviewRecord {
  readonly kind: string;
  readonly ref: string;
  readonly orderId?: string;
  readonly operationId?: string | null;
  readonly contractDue?: number | null;
  readonly status?: string;
}

export interface IssuedMetric {
  readonly id: string;
  readonly coverage: number;
  readonly value: unknown;
}

export interface DecisionReview {
  readonly at: number;
  readonly action: string;
  readonly basisMetric: string;
  readonly basisValue: string;
  readonly basisText: string;
  readonly coverage: number;
  readonly coverageLabel: string;
  readonly consequence: string;
  readonly fact: string;
  readonly verdict: VerdictText;
}

export interface DueLine {
  readonly orderId: string;
  readonly due: number | null;
  readonly closedAt: number | null;
  readonly gap: number | null;
  readonly dueLabel: string;
  readonly closeLabel: string;
  readonly gapLabel: string;
  readonly verdict: VerdictText;
}

export interface ReviewClient {
  session(id: string, shift?: number): Promise<SessionResponse>;
  roles(id: string, shift?: number): Promise<RolesResponse>;
  shop(id: string, shift?: number): Promise<ShopResponse>;
}

export interface ReviewLoad {
  readonly session: SessionResponse;
  readonly roles: RolesResponse;
  readonly shop: ShopResponse;
}

/** Смена решения: сервер датирует его началом смены. */
export function decisionShift(at: number): number {
  return Math.floor(at / SHIFT_MINUTES);
}

/** Срез цеха только на смену, которую открыли. Другие смены не запрашиваются. */
export async function loadReview(api: ReviewClient, sessionId: string, shift: number): Promise<ReviewLoad> {
  const [session, roles, shop] = await Promise.all([
    api.session(sessionId, shift),
    api.roles(sessionId, shift),
    api.shop(sessionId, shift),
  ]);
  return { session, roles, shop };
}

export function shopOf(shop: ShopResponse): ReviewShop {
  return {
    shift: shop.shift,
    warehouseAreaIds: shop.reality.areas
      .filter((area) => area.role.role === 'warehouse')
      .map((area) => area.id),
    operations: shop.reality.operations.map((op) => ({
      id: op.id,
      batchId: op.batchId,
      areaId: op.areaId,
      status: op.status,
      readyAt: op.readyAt,
    })),
  };
}

export function recordsOf(roles: RolesResponse): ReviewRecord[] {
  return roles.records.map((row) => ({
    kind: row.kind,
    ref: row.ref,
    ...(row.orderId !== undefined ? { orderId: row.orderId } : {}),
    ...(row.operationId !== undefined ? { operationId: row.operationId } : {}),
    ...(typeof row.contractDue === 'number' ? { contractDue: row.contractDue } : {}),
    ...(row.status !== undefined ? { status: row.status } : {}),
  }));
}

export function issuedMetrics(summary: SessionResponse['summary']): IssuedMetric[] {
  return METRIC_ORDER.map((id) => ({
    id,
    coverage: summary.metrics[id].coverage,
    value: summary.metrics[id].value,
  }));
}

export function reviewDecisions(input: {
  readonly journal: readonly JournalEntry[];
  readonly shop: ReviewShop;
  readonly roles: readonly ReviewRecord[];
  readonly metrics: readonly IssuedMetric[];
}): readonly DecisionReview[] {
  return input.journal.map((row) => reviewOne(row, input.shop, input.roles, input.metrics));
}

export function dueLines(roles: readonly ReviewRecord[], shop: ReviewShop): readonly DueLine[] {
  const lines: DueLine[] = [];
  for (const row of roles) {
    if (row.kind !== 'order') {
      continue;
    }
    const due = typeof row.contractDue === 'number' ? row.contractDue : null;
    lines.push(dueLine(row.ref, due, closedAtOf(row.ref, roles, shop)));
  }
  return lines;
}

function dueLine(orderId: string, due: number | null, closedAt: number | null): DueLine {
  const dueLabel = due === null ? 'срок не задан' : String(due);
  const closeLabel = closedAt === null ? 'не закрыт' : String(closedAt);
  if (due === null || closedAt === null) {
    return {
      orderId,
      due,
      closedAt,
      gap: null,
      dueLabel,
      closeLabel,
      gapLabel: '—',
      verdict: 'невозможно проверить',
    };
  }
  const gap = closedAt - due;
  const gapLabel = gap > 0
    ? `${gap} мин, заказ опоздал`
    : gap < 0
      ? `${-gap} мин, закрыт раньше срока`
      : '0 мин';
  return {
    orderId,
    due,
    closedAt,
    gap,
    dueLabel,
    closeLabel,
    gapLabel,
    verdict: gap === 0 ? 'подтвердилось' : 'разошлось',
  };
}

function reviewOne(
  row: JournalEntry,
  shop: ReviewShop,
  roles: readonly ReviewRecord[],
  metrics: readonly IssuedMetric[],
): DecisionReview {
  const base = {
    at: row.at,
    action: row.action,
    basisMetric: row.basisMetric,
    basisValue: row.basisValue,
    basisText: formatBasisValue(row.basisMetric, row.basisValue),
    coverage: row.coverage,
    coverageLabel: `покрытие ${coverageText(row.coverage)}`,
    consequence: row.consequence,
  };
  const expected = decisionShift(row.at);
  if (shop.shift !== expected) {
    return {
      ...base,
      fact: `решение на минуте ${row.at} относится к смене ${expected}; открытый срез цеха — смена ${shop.shift}`,
      verdict: 'невозможно проверить',
    };
  }
  const order = orderAction(row.action);
  if (order !== null) {
    return { ...base, ...orderVerdict(order, row, shop, roles, metrics) };
  }
  const batchId = priorityBatch(row.action);
  if (batchId !== null) {
    return { ...base, ...priorityVerdict(batchId, row, shop, metrics) };
  }
  return {
    ...base,
    fact: 'действие в журнале не из трёх решений, сверить не с чем',
    verdict: 'невозможно проверить',
  };
}

function orderVerdict(
  order: { readonly type: 'accept' | 'defer'; readonly orderId: string },
  row: JournalEntry,
  shop: ReviewShop,
  roles: readonly ReviewRecord[],
  metrics: readonly IssuedMetric[],
): { readonly fact: string; readonly verdict: VerdictText } {
  const links = linkedOperationIds(roles, order.orderId);
  const portfolio = metrics.find((metric) => metric.id === 'portfolio');
  if (links.size === 0 || portfolio === undefined) {
    return {
      fact: links.size === 0
        ? `нет записей операций заказа ${order.orderId}, сверить появление партий нельзя`
        : 'в срезе нет портфеля, сверить покрытие нельзя',
      verdict: 'невозможно проверить',
    };
  }
  const appeared = shop.operations.filter((op) => links.has(op.id)).length;
  const current = portfolio.coverage;
  const grown = thousandths(current) > thousandths(row.coverage);
  const numbers = `операций заказа в цехе: ${appeared}. покрытие ${coverageText(current)} (в записи ${coverageText(row.coverage)})`;
  if (order.type === 'accept') {
    if (appeared > 0 && grown) {
      return { fact: `${numbers}. совпадает с записью: партии в цехе, покрытие выросло`, verdict: 'подтвердилось' };
    }
    const parts: string[] = [];
    if (appeared === 0) {
      parts.push('в записи партии запускаются, в цехе операций заказа нет');
    }
    if (!grown) {
      parts.push('в записи заказ входит в покрытие, покрытие не выросло');
    }
    return { fact: `${numbers}. ${parts.join('; ')}`, verdict: 'разошлось' };
  }
  if (appeared === 0 && !grown) {
    return { fact: `${numbers}. совпадает с записью: партий в цехе нет, покрытие не выросло`, verdict: 'подтвердилось' };
  }
  const parts: string[] = [];
  if (appeared > 0) {
    parts.push('в записи партии не запускаются, в цехе операции заказа есть');
  }
  if (grown) {
    parts.push('в записи покрытие не растёт, покрытие выросло');
  }
  return { fact: `${numbers}. ${parts.join('; ')}`, verdict: 'разошлось' };
}

function priorityVerdict(
  batchId: string,
  row: JournalEntry,
  shop: ReviewShop,
  metrics: readonly IssuedMetric[],
): { readonly fact: string; readonly verdict: VerdictText } {
  const count = shop.operations.filter((op) => op.batchId === batchId).length;
  const shopFact = `на смене ${shop.shift} операций партии ${batchId}: ${count}`;
  const metric = metrics.find((item) => item.id === row.basisMetric);
  if (metric === undefined) {
    return {
      fact: `${shopFact}. в срезе нет показателя «${row.basisMetric}», сверить основание нельзя`,
      verdict: 'невозможно проверить',
    };
  }
  const sameValue = sameJson(row.basisValue, metric.value);
  if (sameValue === null) {
    return {
      fact: `${shopFact}. основание в журнале не читается`,
      verdict: 'невозможно проверить',
    };
  }
  const sameCoverage = thousandths(metric.coverage) === thousandths(row.coverage);
  if (sameValue && sameCoverage) {
    return {
      fact: `${shopFact}. выданный срез совпадает с записью`,
      verdict: 'подтвердилось',
    };
  }
  const recorded = formatBasisValue(row.basisMetric, row.basisValue);
  const current = valueText(row.basisMetric, metric.value);
  return {
    fact: `${shopFact}. в записи ${recorded || row.basisValue}, покрытие ${coverageText(row.coverage)}; на выданном срезе ${current || 'значение не читается'}, покрытие ${coverageText(metric.coverage)}`,
    verdict: 'разошлось',
  };
}

function orderAction(action: string): { readonly type: 'accept' | 'defer'; readonly orderId: string } | null {
  const accept = 'принять заказ ';
  const defer = 'отложить заказ ';
  if (action.startsWith(accept)) {
    const orderId = action.slice(accept.length).trim();
    return orderId.length > 0 ? { type: 'accept', orderId } : null;
  }
  if (action.startsWith(defer)) {
    const orderId = action.slice(defer.length).trim();
    return orderId.length > 0 ? { type: 'defer', orderId } : null;
  }
  return null;
}

function priorityBatch(action: string): string | null {
  const prefix = 'приоритет партии ';
  if (!action.startsWith(prefix)) {
    return null;
  }
  const rest = action.slice(prefix.length);
  const mark = ': ранг ';
  const at = rest.indexOf(mark);
  const batchId = (at === -1 ? rest : rest.slice(0, at)).trim();
  return batchId.length > 0 ? batchId : null;
}

function linkedOperationIds(roles: readonly ReviewRecord[], orderId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of roles) {
    if (row.orderId === orderId && typeof row.operationId === 'string' && row.operationId.length > 0) {
      ids.add(row.operationId);
    }
  }
  return ids;
}

function batchIdsOf(orderId: string, roles: readonly ReviewRecord[]): string[] {
  const ids = new Set<string>();
  for (const operationId of linkedOperationIds(roles, orderId)) {
    const at = operationId.lastIndexOf('-op-');
    if (at > 0) {
      ids.add(operationId.slice(0, at));
    }
  }
  return [...ids];
}

function closedAtOf(orderId: string, roles: readonly ReviewRecord[], shop: ReviewShop): number | null {
  const batches = batchIdsOf(orderId, roles);
  if (batches.length === 0) {
    return null;
  }
  let latest: number | null = null;
  for (const batchId of batches) {
    const ready = warehouseReady(shop, batchId);
    if (ready === null) {
      return null;
    }
    latest = latest === null ? ready : Math.max(latest, ready);
  }
  return latest;
}

function warehouseReady(shop: ReviewShop, batchId: string): number | null {
  const ops = shop.operations.filter((op) => op.batchId === batchId && shop.warehouseAreaIds.includes(op.areaId));
  if (ops.length === 0) {
    return null;
  }
  let latest: number | null = null;
  for (const op of ops) {
    if (op.status !== 'done' || typeof op.readyAt !== 'number') {
      return null;
    }
    latest = latest === null ? op.readyAt : Math.max(latest, op.readyAt);
  }
  return latest;
}

function thousandths(value: number): number {
  return Math.round(value * 1000);
}

function sameJson(recorded: string, value: unknown): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recorded) as unknown;
  } catch {
    return null;
  }
  return stable(parsed) === stable(value);
}

function stable(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}
