import type { SimInstant } from '../contract/time.ts';
import type { Quantity } from '../contract/units.ts';

export interface PlanDue {
  readonly orderId: string;
  readonly calculatedDue: SimInstant | null;
}

export interface PlanVersion {
  readonly id: string;
  readonly createdAt: SimInstant;
  readonly reason: string;
  readonly orderDue: readonly PlanDue[];
}

export interface ShiftLine {
  readonly operationId: string;
  readonly norm: Quantity<'norm-hour'>;
}

/** Снимок утверждения смены. Пересчёт плана его не заменяет. */
export interface ShiftSnapshot {
  readonly id: string;
  readonly shiftIndex: number;
  readonly approvedAt: SimInstant;
  readonly sourceVersionId: string;
  readonly lines: readonly ShiftLine[];
}

function freezeVersion(version: PlanVersion): PlanVersion {
  return Object.freeze({
    ...version,
    orderDue: Object.freeze(version.orderDue.map((row) => Object.freeze({ ...row }))),
  });
}

export function appendVersion(history: readonly PlanVersion[], next: PlanVersion): readonly PlanVersion[] {
  if (history.some((version) => version.id === next.id)) {
    throw new Error(`Версия плана «${next.id}» уже есть. Пересчёт создаёт новую версию.`);
  }
  return Object.freeze([...history, freezeVersion(next)]);
}

export function approveShift(version: PlanVersion, snapshot: ShiftSnapshot): ShiftSnapshot {
  if (snapshot.sourceVersionId !== version.id) {
    throw new Error('Снимок смены ссылается не на ту версию плана.');
  }
  return Object.freeze({
    ...snapshot,
    lines: Object.freeze(snapshot.lines.map((line) => Object.freeze({ ...line, norm: { ...line.norm } }))),
  });
}

/** Новая версия добавляется рядом. Снимок остаётся тем же объектом. */
export function recalculate(
  history: readonly PlanVersion[],
  snapshot: ShiftSnapshot,
  next: PlanVersion,
): { readonly history: readonly PlanVersion[]; readonly snapshot: ShiftSnapshot } {
  return { history: appendVersion(history, next), snapshot };
}
