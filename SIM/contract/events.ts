import { isReadableVersion } from './version.ts';
import { parseEventV1, type ContractEventV1 } from './v1/events.ts';
import { parseEventV2, type MaterialArrivedV2 } from './v2/events.ts';

export type ContractEvent = ContractEventV1 | MaterialArrivedV2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Читает событие по номеру его версии. Схему прежней версии не переписывает. */
export function readContractEvent(raw: unknown): ContractEvent {
  if (!isRecord(raw)) {
    throw new Error('Событие контракта должно быть объектом.');
  }
  const version = raw['version'];
  if (typeof version !== 'number' || !isReadableVersion(version)) {
    throw new Error(`Версия события не читается: ${String(version)}.`);
  }
  if (version === 1) {
    return parseEventV1(raw);
  }
  return parseEventV2(raw);
}
