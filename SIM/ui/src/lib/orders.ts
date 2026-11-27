/**
 * Неразобранные заказы из среза ролей. Экран не решает, кто неразобран:
 * берёт статус, который уже лежит в записи.
 */
export interface PendingOrder {
  readonly id: string;
  readonly due: number | null;
}

export function pendingOrders(roles: {
  readonly records: readonly {
    readonly kind: string;
    readonly ref: string;
    readonly status?: string;
    readonly contractDue?: number;
  }[];
}): readonly PendingOrder[] {
  const rows: PendingOrder[] = [];
  for (const row of roles.records) {
    if (row.kind !== 'order' || row.status !== 'unparsed') {
      continue;
    }
    rows.push({ id: row.ref, due: row.contractDue ?? null });
  }
  return rows;
}
