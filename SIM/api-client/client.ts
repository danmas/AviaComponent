/**
 * Клиент контракта v1. Не знает ни про React, ни про DOM, ни про конкретный
 * транспорт: fetch передаётся снаружи, поэтому тот же клиент работает в Node
 * (прогоны в тестах) и в браузере (экраны).
 *
 * Правила, которые клиент соблюдает сам:
 * - версия в пути, поэтому все маршруты строятся от `/v1`;
 * - ответ помечается версией, и клиент её проверяет, а не доверяет молча;
 * - неизвестный тип события не ломает чтение потока.
 */
import type {
  AdvanceResponse,
  DecisionResponse,
  RolesResponse,
  SessionResponse,
  ShopResponse,
} from './types.ts';

export interface Transport {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Транспорт. По умолчанию — fetch среды. */
  readonly transport?: Transport;
  /** Версия, которую ждёт клиент. Ответ с другой версией — ошибка, а не тихий пропуск. */
  readonly apiVersion?: string;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Запрос отклонён: ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateSessionBody {
  readonly seed: number;
  readonly level: string;
  readonly overlay: string;
  readonly horizonShifts?: number;
}

export interface DecisionBody {
  readonly type: string;
  readonly batchId: string;
  readonly rank: number;
  readonly appliedAt?: number;
}

/** Событие потока. Клиент обязан понимать пять типов и игнорировать остальные. */
export interface StreamEvent {
  readonly apiVersion?: string | undefined;
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly payload: unknown;
}

export const KNOWN_EVENTS = [
  'shift-started',
  'shift-completed',
  'metrics-updated',
  'decision-applied',
  'session-finished',
] as const;

export type KnownEventType = (typeof KNOWN_EVENTS)[number];

export function isKnownEvent(event: StreamEvent): event is StreamEvent & { type: KnownEventType } {
  return (KNOWN_EVENTS as readonly string[]).includes(event.type);
}

export interface Client {
  createSession(body: CreateSessionBody): Promise<SessionResponse>;
  session(id: string, shift?: number): Promise<SessionResponse>;
  shop(id: string, shift?: number): Promise<ShopResponse>;
  roles(id: string, shift?: number): Promise<RolesResponse>;
  decide(id: string, body: DecisionBody): Promise<DecisionResponse>;
  advance(id: string): Promise<AdvanceResponse>;
  streamUrl(id: string, lastSeq?: number): string;
}

/** fetch среды. Не вызывается при создании клиента: только в момент запроса. */
function defaultTransport(): Transport {
  const native = (globalThis as { fetch?: unknown }).fetch;
  if (typeof native !== 'function') {
    throw new Error('В среде нет fetch: передайте транспорт в createClient.');
  }
  return native as unknown as Transport;
}

export function createClient(options: ClientOptions): Client {
  const base = options.baseUrl.replace(/\/+$/, '');
  const expected = options.apiVersion ?? 'v1';
  const send = options.transport ?? defaultTransport();

  function url(path: string, shift?: number): string {
    const suffix = shift === undefined ? '' : `?shift=${shift}`;
    return `${base}/v1${path}${suffix}`;
  }

  async function call<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await send(path, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers: { 'Content-Type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    const body: unknown = text === '' ? null : JSON.parse(text);
    if (response.status >= 400) {
      throw new ApiClientError(response.status, body);
    }
    const version = (body as { apiVersion?: unknown }).apiVersion;
    if (version !== expected) {
      throw new Error(`Ответ версии «${String(version)}», клиент ждёт «${expected}».`);
    }
    return body as T;
  }

  return {
    createSession(body) {
      return call<SessionResponse>(url('/sessions'), { method: 'POST', body: JSON.stringify(body) });
    },
    session(id, shift) {
      return call<SessionResponse>(url(`/sessions/${id}`, shift));
    },
    shop(id, shift) {
      return call<ShopResponse>(url(`/sessions/${id}/shop`, shift));
    },
    roles(id, shift) {
      return call<RolesResponse>(url(`/sessions/${id}/roles`, shift));
    },
    decide(id, body) {
      return call<DecisionResponse>(url(`/sessions/${id}/decisions`), { method: 'POST', body: JSON.stringify(body) });
    },
    advance(id) {
      return call<AdvanceResponse>(url(`/sessions/${id}/advance`), { method: 'POST' });
    },
    streamUrl(id, lastSeq) {
      const wsBase = base.replace(/^http/, 'ws');
      const suffix = lastSeq === undefined ? '' : `?lastSeq=${lastSeq}`;
      return `${wsBase}/v1/sessions/${id}/stream${suffix}`;
    },
  };
}
