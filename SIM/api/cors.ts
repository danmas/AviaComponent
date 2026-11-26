/**
 * CORS явным списком источников. «*» отвергается при разборе конфигурации:
 * контракт предназначен наружу, и звёздочка с учётными данными — известная ошибка.
 */
export class CorsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsConfigError';
  }
}

export interface CorsConfig {
  /** Разрешённые источники. Пустой список — CORS выключен, проходят только запросы без Origin. */
  readonly origins: readonly string[];
}

export function parseOrigins(raw: string | undefined): CorsConfig {
  if (raw === undefined || raw.trim() === '') {
    return { origins: [] };
  }
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  for (const origin of parts) {
    if (origin === '*') {
      throw new CorsConfigError('SIM_API_ORIGINS не принимает «*». Перечислите источники явно.');
    }
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new CorsConfigError(`Источник «${origin}» не похож на адрес вида http://host:port.`);
    }
  }
  return { origins: parts };
}

export function originFromEnv(env: NodeJS.ProcessEnv = process.env): CorsConfig {
  return parseOrigins(env.SIM_API_ORIGINS ?? env.SIM_API_CORS_ORIGINS);
}

export interface CorsDecision {
  readonly allowed: boolean;
  readonly allowOrigin: string | null;
}

/** Источник не из списка не получает разрешающего заголовка. */
export function decideCors(config: CorsConfig, origin: string | undefined): CorsDecision {
  if (origin === undefined) {
    return { allowed: true, allowOrigin: null };
  }
  if (config.origins.includes(origin)) {
    return { allowed: true, allowOrigin: origin };
  }
  return { allowed: false, allowOrigin: null };
}
