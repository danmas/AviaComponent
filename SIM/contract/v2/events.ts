import { parseEventV1, type MaterialArrivedV1 } from '../v1/events.ts';

/**
 * Версия 2 добавляет поле к приходу материала и не меняет схему версии 1.
 * Остальные типы по-прежнему читаются только как версия 1.
 */
export interface MaterialArrivedV2 extends Omit<MaterialArrivedV1, 'version'> {
  readonly version: 2;
  readonly note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEventV2(raw: unknown): MaterialArrivedV2 {
  if (!isRecord(raw)) {
    throw new Error('Событие версии 2 должно быть объектом.');
  }
  if (raw['version'] !== 2) {
    throw new Error('parseEventV2 читает только версию 2.');
  }
  if (raw['type'] !== 'material-arrived') {
    throw new Error('В версии 2 пока добавлено только поле прихода материала. Остальные типы остаются в версии 1.');
  }
  const note = raw['note'];
  if (typeof note !== 'string' || note.trim().length === 0) {
    throw new Error('Версия 2 прихода материала требует непустую пометку note.');
  }
  const asV1 = parseEventV1({ ...raw, version: 1 });
  if (asV1.type !== 'material-arrived') {
    throw new Error('Приход материала версии 2 не разобран.');
  }
  return Object.freeze({ ...asV1, version: 2 as const, note });
}
