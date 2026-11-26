import { applyTearOff, pieces, transferred, type Pieces, type TearOffGround } from '../contract/quantity.ts';
import { ROUTE } from './stand.ts';
import {
  goodPieces,
  resourceDown,
  type MissingGate,
  type OperationStatus,
  type PlantBatch,
  type PlantOperation,
  type PlantState,
} from './state.ts';

export interface NewBatch {
  readonly id: string;
  readonly partId: string;
  readonly qty: Pieces;
  readonly materialReady: boolean;
  readonly designDocReady: boolean;
}

function gate(
  batch: Pick<PlantBatch, 'materialReady' | 'designDocReady'>,
  sequence: number,
  previousDone: boolean,
  planned: Pieces,
): { status: OperationStatus; missing: readonly MissingGate[] } {
  const missing: MissingGate[] = [];
  if (!batch.materialReady) {
    missing.push('material');
  }
  if (!batch.designDocReady) {
    missing.push('kd');
  }
  if (sequence > 0 && !previousDone) {
    missing.push('previous');
  }
  const status: OperationStatus = missing.length > 0 || planned === 0 ? 'not-ready' : 'ready';
  return { status, missing };
}

function operationsFor(batch: NewBatch): PlantOperation[] {
  return ROUTE.map((step, sequence) => {
    const planned = sequence === 0 ? batch.qty : pieces(0);
    const opened = gate(batch, sequence, sequence === 0, planned);
    return {
      id: `${batch.id}-op-${sequence}`,
      batchId: batch.id,
      areaId: step.areaId,
      sequence,
      status: opened.status,
      missing: opened.missing,
      planned,
      done: pieces(0),
      scrap: pieces(0),
      effort: step.effort,
      resourceId: null,
    };
  });
}

export function launchBatch(state: PlantState, input: NewBatch): PlantState {
  if (state.batches.some((batch) => batch.id === input.id)) {
    throw new Error(`Партия «${input.id}» уже есть.`);
  }
  if (input.qty <= 0) {
    throw new Error('Пустая партия не запускается.');
  }
  const operations = operationsFor(input);
  const batch: PlantBatch = {
    id: input.id,
    partId: input.partId,
    qty: input.qty,
    parentId: null,
    tearOff: null,
    countsApart: true,
    materialReady: input.materialReady,
    designDocReady: input.designDocReady,
    operationIds: operations.map((operation) => operation.id),
  };
  return {
    ...state,
    batches: [...state.batches, batch],
    operations: [...state.operations, ...operations],
  };
}

function requireBatch(state: PlantState, batchId: string): PlantBatch {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) {
    throw new Error(`Партия «${batchId}» не найдена.`);
  }
  return batch;
}

function requireOperation(state: PlantState, operationId: string): PlantOperation {
  const operation = state.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw new Error(`Операция «${operationId}» не найдена.`);
  }
  return operation;
}

export function tearOffBatch(
  state: PlantState,
  parentId: string,
  childId: string,
  childQty: Pieces,
  ground: TearOffGround,
): PlantState {
  const parent = requireBatch(state, parentId);
  if (state.batches.some((batch) => batch.id === childId)) {
    throw new Error(`Партия «${childId}» уже есть.`);
  }
  const parentOps = state.operations.filter((operation) => operation.batchId === parent.id);
  if (parentOps.some((operation) => operation.status === 'running' || operation.status === 'done' || operation.done > 0)) {
    throw new Error('Отрыв после начала обработки в ядре v1 не выполняется: глубина не задана спецификацией.');
  }
  const split = applyTearOff(parent.qty, childQty, ground);
  const parentNext: PlantBatch = {
    ...parent,
    qty: split.parentQty,
  };
  const childInput: NewBatch = {
    id: childId,
    partId: parent.partId,
    qty: split.childQty,
    materialReady: parent.materialReady,
    designDocReady: parent.designDocReady,
  };
  const childOps = operationsFor(childInput);
  const child: PlantBatch = {
    id: childId,
    partId: parent.partId,
    qty: split.childQty,
    parentId: parent.id,
    tearOff: ground,
    countsApart: split.childCountsApart,
    materialReady: parent.materialReady,
    designDocReady: parent.designDocReady,
    operationIds: childOps.map((operation) => operation.id),
  };
  const operations = state.operations.map((operation) => {
    if (operation.batchId !== parent.id || split.childCountsApart === false) {
      return operation;
    }
    const planned = pieces(operation.sequence === 0 ? split.parentQty : 0);
    const opened = gate(parentNext, operation.sequence, false, planned);
    return {
      ...operation,
      planned,
      status: operation.sequence === 0 ? opened.status : operation.status,
      missing: operation.sequence === 0 ? opened.missing : operation.missing,
    };
  });
  return {
    ...state,
    batches: state.batches.map((batch) => (batch.id === parent.id ? parentNext : batch)).concat(child),
    operations: [...operations, ...childOps],
  };
}

export function startOperation(state: PlantState, operationId: string, resourceId: string): PlantState {
  const operation = requireOperation(state, operationId);
  if (operation.status !== 'ready') {
    throw new Error('Стартует только готовая операция.');
  }
  const resource = state.resources.find((item) => item.id === resourceId);
  if (!resource || resource.areaId !== operation.areaId) {
    throw new Error('Ресурс не принадлежит участку операции.');
  }
  if (resourceDown(state, resource.id, state.now)) {
    throw new Error('Ресурс в простое.');
  }
  const busy = state.operations.some((item) => item.resourceId === resource.id && item.status === 'running');
  if (busy) {
    throw new Error('Ресурс уже занят. Станок и печь ведутся очередью, человек — одной работой.');
  }
  if (resource.kind === 'furnaces') {
    if (resource.chargePieces === null) {
      throw new Error('У печи не задана садка.');
    }
    if (operation.planned > resource.chargePieces) {
      throw new Error('Партия больше садки. Деление нужно до посадки в печь.');
    }
  }
  return {
    ...state,
    operations: state.operations.map((item) =>
      item.id === operation.id ? { ...item, status: 'running', resourceId: resource.id } : item,
    ),
  };
}

export function completeOperation(state: PlantState, operationId: string, done: Pieces, scrap: Pieces): PlantState {
  const operation = requireOperation(state, operationId);
  if (operation.status !== 'running') {
    throw new Error('Закрывается только начатая операция.');
  }
  if (done !== operation.planned) {
    throw new Error('В ядре v1 операция закрывается целиком.');
  }
  const good = transferred(done, scrap);
  const batch = requireBatch(state, operation.batchId);
  let operations = state.operations.map((item) =>
    item.id === operation.id ? { ...item, status: 'done' as const, done, scrap } : item,
  );
  const next = operations.find((item) => item.batchId === operation.batchId && item.sequence === operation.sequence + 1);
  if (next) {
    const opened = gate(batch, next.sequence, true, good);
    operations = operations.map((item) =>
      item.id === next.id ? { ...item, planned: good, status: opened.status, missing: opened.missing } : item,
    );
  }
  return { ...state, operations };
}

/** Склад ГП не занимает станок. Приёмка возможна, когда предыдущая операция сдана. */
export function receiveToWarehouse(state: PlantState, operationId: string): PlantState {
  const operation = requireOperation(state, operationId);
  const area = state.areas.find((item) => item.id === operation.areaId);
  if (!area || area.role.role !== 'warehouse') {
    throw new Error('На склад принимается только операция склада ГП.');
  }
  if (operation.status !== 'ready') {
    throw new Error('Склад принимает только готовую передачу.');
  }
  return {
    ...state,
    operations: state.operations.map((item) =>
      item.id === operation.id
        ? { ...item, status: 'done' as const, done: item.planned, scrap: pieces(0) }
        : item,
    ),
  };
}

export function passedPieces(state: PlantState, operationId: string): Pieces {
  const operation = requireOperation(state, operationId);
  if (operation.status !== 'done') {
    throw new Error('Незакрытая операция ещё ничего не передала.');
  }
  return goodPieces(operation);
}
