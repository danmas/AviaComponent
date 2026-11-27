import { pieces, type Pieces, type TearOffGround } from '../contract/quantity.ts';
import { instant, type SimInstant } from '../contract/time.ts';
import type { ShopSlice } from '../contract/slices.ts';
import type { AnyQuantity } from '../contract/units.ts';
import { PLANT_STAND, ROUTE, type AreaRole, type Evidence, type ResourceKind } from './stand.ts';

export type MissingGate = 'material' | 'kd' | 'previous';

export type OperationStatus = 'not-ready' | 'ready' | 'running' | 'done';

export type DowntimeReason = 'no-material' | 'no-task' | 'breakdown';

export interface Area {
  readonly id: string;
  readonly name: string;
  readonly role: AreaRole;
  readonly evidence: Evidence;
  readonly evidenceNote: string;
}

export interface Resource {
  readonly id: string;
  readonly areaId: string;
  readonly kind: ResourceKind;
  /** Штук в одной садке. Только у печи. */
  readonly chargePieces: number | null;
}

export interface PlantBatch {
  readonly id: string;
  readonly partId: string;
  readonly qty: Pieces;
  readonly parentId: string | null;
  readonly tearOff: TearOffGround | null;
  /** false только у потомка по ведомости дефекта: его штуки уже в родителе. */
  readonly countsApart: boolean;
  readonly materialReady: boolean;
  readonly designDocReady: boolean;
  readonly operationIds: readonly string[];
}

export interface PlantOperation {
  readonly id: string;
  readonly batchId: string;
  readonly areaId: string;
  readonly sequence: number;
  readonly status: OperationStatus;
  readonly missing: readonly MissingGate[];
  /**
   * Момент, когда операция стала готовой к запуску. Пусто, пока хоть одни
   * ворота закрыты. Хранится момент, а не длительность ожидания: длительность
   * растёт при наблюдении, а момент неизменен — только так прошлый срез
   * остаётся тем же самым.
   */
  readonly readyAt: SimInstant | null;
  /**
   * Момент запуска операции на ресурсе. Пусто, пока операция не начата.
   * Нужен, чтобы пролёживание законченного ожидания не росло: у работающей
   * и закрытой операции оно равно `startedAt − readyAt` и дальше не меняется.
   */
  readonly startedAt: SimInstant | null;
  readonly planned: Pieces;
  readonly done: Pieces;
  readonly scrap: Pieces;
  readonly effort: AnyQuantity | null;
  readonly resourceId: string | null;
}

export interface Downtime {
  readonly id: string;
  readonly resourceId: string;
  readonly from: SimInstant;
  readonly until: SimInstant | null;
  readonly reason: DowntimeReason;
}

/** Наблюдаемое состояние цеха. Расчёт показателей Системы его не получает. */
export interface PlantState {
  readonly now: SimInstant;
  readonly areas: readonly Area[];
  readonly resources: readonly Resource[];
  readonly batches: readonly PlantBatch[];
  readonly operations: readonly PlantOperation[];
  readonly downtimes: readonly Downtime[];
}

export function createShop(now: SimInstant = instant(0)): PlantState {
  const areas: Area[] = ROUTE.map((step) => ({
    id: step.areaId,
    name: step.areaName,
    role: step.role,
    evidence: step.evidence,
    evidenceNote: step.evidenceNote,
  }));
  const resources: Resource[] = [];
  for (const step of ROUTE) {
    if (step.role.role !== 'processing') {
      continue;
    }
    resources.push({
      id: `${step.areaId}-1`,
      areaId: step.areaId,
      kind: step.role.resourceKind,
      chargePieces: step.role.resourceKind === 'furnaces' ? PLANT_STAND.furnaceChargePieces : null,
    });
  }
  return {
    now,
    areas,
    resources,
    batches: [],
    operations: [],
    downtimes: [],
  };
}

export function shopSlice(state: PlantState): ShopSlice<PlantState> {
  return { layer: 'shop', reality: state };
}

export function operationVisibleInShop(state: PlantState, operationId: string): boolean {
  return state.operations.some((operation) => operation.id === operationId);
}

export function at(state: PlantState, now: SimInstant): PlantState {
  return { ...state, now };
}

export function addDowntime(state: PlantState, downtime: Downtime): PlantState {
  if (downtime.until !== null && downtime.until <= downtime.from) {
    throw new Error('Конец простоя должен быть позже начала.');
  }
  if (!state.resources.some((resource) => resource.id === downtime.resourceId)) {
    throw new Error('Простой относится к неизвестному ресурсу.');
  }
  return { ...state, downtimes: [...state.downtimes, downtime] };
}

export function resourceDown(state: PlantState, resourceId: string, atTime: SimInstant): boolean {
  return state.downtimes.some((downtime) => {
    if (downtime.resourceId !== resourceId || downtime.from > atTime) {
      return false;
    }
    return downtime.until === null || atTime < downtime.until;
  });
}

export function goodPieces(operation: PlantOperation): Pieces {
  if (operation.scrap > operation.done) {
    throw new Error('В операции брак больше сделанного.');
  }
  return pieces(operation.done - operation.scrap);
}
