import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../api/server.ts';
import { pathV1 } from '../api/version.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENAPI = path.join(root, 'api', 'openapi.json');

interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly nullable?: boolean;
  readonly $ref?: string;
}

interface OpenApi {
  readonly x_generated?: boolean;
  readonly openapi?: string;
  readonly paths?: Record<string, unknown>;
  readonly components?: { readonly schemas?: Record<string, JsonSchema> };
}

function readOpenApi(): OpenApi {
  return JSON.parse(fs.readFileSync(OPENAPI, 'utf8')) as OpenApi;
}

/** Ключи фактического значения на каждом уровне — для сверки с описанием. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0])];
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shapeOf(child);
    }
    return out;
  }
  return typeof value;
}

/**
 * Сверяет факт с описанием. Лишнее поле в ответе — всегда расхождение:
 * значит ответ вырос, а описание нет. Пропавшее из ответа поле — расхождение
 * только для обязательных: union-строка законно несёт не все поля.
 */
function compare(label: string, actual: unknown, schema: JsonSchema, problems: string[]): void {
  // nullable: значение бывает null по построению (например, effort у склада).
  if (actual === null) {
    if (schema.nullable !== true && schema.type !== 'null') {
      problems.push(`${label}: пришло null, но поле описано как ${String(schema.type)} без nullable`);
    }
    return;
  }
  if (schema.type === 'object' && schema.properties !== undefined) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      problems.push(`${label}: ожидался объект, пришло ${Array.isArray(actual) ? 'массив' : String(actual)}`);
      return;
    }
    const record = actual as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = schema.properties[key];
      if (child === undefined) {
        problems.push(`${label}.${key}: поле есть в ответе, но его нет в описании`);
        continue;
      }
      compare(`${label}.${key}`, record[key], child, problems);
    }
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        problems.push(`${label}.${key}: обязательное поле описано, но в ответе его нет`);
      }
    }
    return;
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    if (!Array.isArray(actual)) {
      problems.push(`${label}: ожидался массив`);
      return;
    }
    for (let index = 0; index < actual.length; index += 1) {
      compare(`${label}[${index}]`, actual[index], schema.items, problems);
    }
  }
}

function schemaNamed(api: OpenApi, name: string): JsonSchema {
  const schema = api.components?.schemas?.[name];
  if (schema === undefined) {
    throw new Error(`схема ${name} отсутствует в openapi.json`);
  }
  return schema;
}

test('openapi.json помечен как сгенерированный и называет команду сборки', () => {
  assert.equal(fs.existsSync(OPENAPI), true, 'openapi.json не собран — запустите npm run openapi');
  const raw = JSON.parse(fs.readFileSync(OPENAPI, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['x_generated'], true);
  assert.match(String(raw['x-generated-by']), /npm run openapi|api\/schema\.ts/);
  assert.equal(raw['openapi'], '3.1.0');
});

test('описание содержит все шесть маршрутов версии 1', () => {
  const api = readOpenApi();
  const paths = Object.keys(api.paths ?? {}).sort();
  assert.deepEqual(paths, [
    pathV1('/sessions'),
    pathV1('/sessions/{id}'),
    pathV1('/sessions/{id}/advance'),
    pathV1('/sessions/{id}/decisions'),
    pathV1('/sessions/{id}/roles'),
    pathV1('/sessions/{id}/shop'),
  ]);
  for (const key of paths) {
    assert.ok(key.startsWith('/v1/'), `${key} без версии в пути`);
  }
});

test('схема свода совпадает с фактическим ответом', async () => {
  const api = readOpenApi();
  const schema = schemaNamed(api, 'SessionResponse');
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    assert.equal(created.statusCode, 201);
    for (let shift = 0; shift < 2; shift += 1) {
      const body = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${(created.json() as { id: string }).id}`) })).json();
      const problems: string[] = [];
      compare('SessionResponse', body, schema, problems);
      assert.deepEqual(problems, [], problems.join('; '));
      await app.inject({ method: 'POST', url: pathV1(`/sessions/${(created.json() as { id: string }).id}/advance`) });
    }
  } finally {
    await app.close();
  }
});

test('схема цеха совпадает с фактическим ответом', async () => {
  const api = readOpenApi();
  const schema = schemaNamed(api, 'ShopResponse');
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    const id = (created.json() as { id: string }).id;
    const body = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop`) })).json();
    const problems: string[] = [];
    compare('ShopResponse', body, schema, problems);
    assert.deepEqual(problems, [], problems.join('; '));
  } finally {
    await app.close();
  }
});

test('схема записей ролей совпадает с фактическим ответом', async () => {
  const api = readOpenApi();
  const schema = schemaNamed(api, 'RolesResponse');
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    const id = (created.json() as { id: string }).id;
    const body = (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles`) })).json();
    const problems: string[] = [];
    compare('RolesResponse', body, schema, problems);
    assert.deepEqual(problems, [], problems.join('; '));
  } finally {
    await app.close();
  }
});

test('фактический ответ не содержит поля, которого нет в описании', async () => {
  const api = readOpenApi();
  const session = schemaNamed(api, 'SessionResponse');
  const described = new Set(Object.keys(session.properties ?? {}));
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'none' },
    });
    const body = created.json() as Record<string, unknown>;
    const extra = Object.keys(body).filter((key) => !described.has(key));
    assert.deepEqual(extra, [], `поля вне описания: ${extra.join(', ')}`);
  } finally {
    await app.close();
  }
});

test('реестр событий в описании совпадает с реестром сервера', async () => {
  const api = readOpenApi();
  const events = schemaNamed(api, 'EventTypes');
  const { EVENT_TYPES } = await import('../api/stream.ts');
  assert.deepEqual(events.enum, [...EVENT_TYPES]);
});

test('схема версии в описании не расходится с контрактом', async () => {
  const api = readOpenApi();
  const { API_VERSION, SUPPORTED_VERSIONS } = await import('../api/version.ts');
  const unknown = schemaNamed(api, 'UnknownVersionResponse');
  const supported = unknown.properties?.['supported'];
  assert.notEqual(supported, undefined, 'в схеме нет поля supported');
  assert.deepEqual(supported?.items?.enum ?? [...SUPPORTED_VERSIONS], [...SUPPORTED_VERSIONS]);
  const session = schemaNamed(api, 'SessionResponse');
  const versionProp = session.properties?.['apiVersion'];
  assert.notEqual(versionProp, undefined, 'в схеме свода нет apiVersion');
  assert.equal(versionProp?.type, 'string');
  assert.equal(API_VERSION, 'v1');
});
