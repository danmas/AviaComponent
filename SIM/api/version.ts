/**
 * Версия HTTP-контракта. Версия идёт префиксом пути и дублируется в теле ответа:
 * ответ может быть сохранён в файл или лог, где путь уже потерян.
 */
export const API_VERSION = 'v1' as const;

export type ApiVersion = typeof API_VERSION;

/** Поддерживаемые версии. Неизвестная версия адресована другой версии, а не содержит ошибку в теле. */
export const SUPPORTED_VERSIONS = [API_VERSION] as const;

export const VERSION_PREFIX = `/${API_VERSION}` as const;

export interface Versioned {
  readonly apiVersion: ApiVersion;
}

/** Помечает тело ответа версией. Работает и на отказе. */
export function versioned<T extends object>(body: T): T & Versioned {
  return { apiVersion: API_VERSION, ...body };
}

export interface UnknownVersionBody {
  readonly apiVersion: ApiVersion;
  readonly error: 'unknown-api-version';
  readonly supported: readonly string[];
}

export function unknownVersionBody(): UnknownVersionBody {
  return { apiVersion: API_VERSION, error: 'unknown-api-version', supported: [...SUPPORTED_VERSIONS] };
}

/** Путь с префиксом версии. */
export function pathV1(path: string): string {
  return path === '/' ? VERSION_PREFIX : `${VERSION_PREFIX}${path}`;
}
