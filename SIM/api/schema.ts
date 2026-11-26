/**
 * Сборка openapi.json из фактических ответов сервера.
 *
 * Описание не пишется руками: схемы выводятся из ответов, снятых на фиксированном
 * прогоне. Ручная правка обнаруживается тестом сверки — схемы перестают совпадать
 * с ответом.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './server.ts';
import { pathV1 } from './version.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, 'openapi.json');
const SEED = 42;

type Any = Record<string, unknown>;

function isPlainObject(value: unknown): value is Any {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Схема значения: объекты — со свойствами, массивы — объединение по всем элементам. */
function schemaOf(value: unknown): Any {
  if (value === null) {
    return { type: 'null', nullable: true };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: {} };
    }
    return { type: 'array', items: value.map(schemaOf).reduce(mergeSchemas) };
  }
  if (isPlainObject(value)) {
    const properties: Any = {};
    for (const [key, child] of Object.entries(value)) {
      properties[key] = schemaOf(child);
    }
    return { type: 'object', properties, required: Object.keys(value).sort() };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  return { type: 'string' };
}

/**
 * Объединяет схемы одной формы. Объекты дают союз свойств, а обязательными
 * остаются только общие ключи: так описывается union-строка, у которой набор
 * полей зависит от вида записи.
 */
function mergeSchemas(left: Any, right: Any): Any {
  const leftNullable = left['type'] === 'null' || left['nullable'] === true;
  const rightNullable = right['type'] === 'null' || right['nullable'] === true;
  if (left['type'] === 'null') {
    return { ...right, nullable: true };
  }
  if (right['type'] === 'null') {
    return { ...left, nullable: true };
  }
  if (leftNullable || rightNullable) {
    const base = leftNullable ? { ...right } : { ...left };
    return { ...base, nullable: true };
  }
  if (left['type'] === 'object' && right['type'] === 'object') {
    const leftProps = (left['properties'] ?? {}) as Any;
    const rightProps = (right['properties'] ?? {}) as Any;
    const properties: Any = {};
    for (const key of new Set([...Object.keys(leftProps), ...Object.keys(rightProps)])) {
      const a = leftProps[key];
      const b = rightProps[key];
      properties[key] = a === undefined ? b : b === undefined ? a : mergeSchemas(a as Any, b as Any);
    }
    const leftRequired = new Set((left['required'] ?? []) as string[]);
    const rightRequired = (right['required'] ?? []) as string[];
    const required = Object.keys(properties).filter((key) => leftRequired.has(key) && rightRequired.includes(key)).sort();
    return { type: 'object', properties, required };
  }
  if (left['type'] === 'array' && right['type'] === 'array') {
    const li = (left['items'] ?? {}) as Any;
    const ri = (right['items'] ?? {}) as Any;
    const items = Object.keys(li).length === 0
      ? ri
      : Object.keys(ri).length === 0
        ? li
        : mergeSchemas(li, ri);
    return { type: 'array', items };
  }
  return left;
}

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: SEED, level: 'clean', overlay: 'none' },
    });
    const id = (created.json() as { id: string }).id;

    const shapes: Record<string, Any> = {};
    const record = (name: string, value: unknown): void => {
      const next = schemaOf(value);
      shapes[name] = shapes[name] === undefined ? next : mergeSchemas(shapes[name] as Any, next);
    };

    record('SessionResponse', created.json());
    for (let step = 0; step < 3; step += 1) {
      const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
      record('AdvanceResponse', advanced.json());
      record('SessionResponse', (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}`) })).json());
      record('ShopResponse', (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop`) })).json());
      record('RolesResponse', (await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles`) })).json());
    }
    record('DecisionResponse', (await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${id}/decisions`),
      payload: { type: 'priority', batchId: 'batch-3', rank: 0 },
    })).json());
    record('ErrorResponse', { apiVersion: 'v1', error: 'сообщение' });
    record('UnknownVersionResponse', { apiVersion: 'v1', error: 'unknown-api-version', supported: ['v1'] });

    const openapi = {
      x_generated: true,
      'x-generated-by': 'node --experimental-strip-types api/schema.ts',
      'x-fixture': { seed: SEED, level: 'clean', overlay: 'none' },
      openapi: '3.1.0',
      info: {
        title: 'Симулятор: контракт API',
        version: 'v1',
        description:
          'Схемы выведены из фактических ответов сервера на фиксированном прогоне. ' +
          'Ручная правка файла запрещена: изменение типа в ядре обязано менять описание.',
      },
      servers: [{ url: 'http://127.0.0.1:3400' }],
      paths: {
        [pathV1('/sessions')]: {
          post: {
            summary: 'Создать сессию',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['seed', 'level', 'overlay'],
                    additionalProperties: false,
                    properties: {
                      seed: { type: 'integer' },
                      level: { type: 'string', enum: ['clean', 'late', 'paper', 'empty'] },
                      overlay: { type: 'string', enum: ['none', 'urgent', 'breakdown', 'scrap'] },
                      horizonShifts: { type: 'integer', minimum: 10, maximum: 15 },
                    },
                  },
                },
              },
            },
            responses: {
              201: { description: 'Сессия создана', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionResponse' } } } },
              400: { description: 'Тело отклонено', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            },
          },
        },
        [pathV1('/sessions/{id}')]: {
          get: {
            summary: 'Срез свода без состояния цеха',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: { description: 'Свод', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionResponse' } } } },
              404: { description: 'Сессия не найдена', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            },
          },
        },
        [pathV1('/sessions/{id}/shop')]: {
          get: {
            summary: 'Срез цеха, только по явному запросу',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: { description: 'Слой shop', content: { 'application/json': { schema: { $ref: '#/components/schemas/ShopResponse' } } } },
            },
          },
        },
        [pathV1('/sessions/{id}/roles')]: {
          get: {
            summary: 'Записи ролей, слой roles',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: { description: 'Слой roles', content: { 'application/json': { schema: { $ref: '#/components/schemas/RolesResponse' } } } },
            },
          },
        },
        [pathV1('/sessions/{id}/decisions')]: {
          post: {
            summary: 'Решение о приоритете, действует вперёд',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: { description: 'Решение записано', content: { 'application/json': { schema: { $ref: '#/components/schemas/DecisionResponse' } } } },
              409: { description: 'Момент применения в прошлом', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            },
          },
        },
        [pathV1('/sessions/{id}/advance')]: {
          post: {
            summary: 'Шаг на следующую смену',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              200: { description: 'Смена закрыта, события возвращены', content: { 'application/json': { schema: { $ref: '#/components/schemas/AdvanceResponse' } } } },
              409: { description: 'Горизонт исчерпан', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          ...(shapes as Any),
          EventTypes: {
            type: 'string',
            enum: ['shift-started', 'shift-completed', 'metrics-updated', 'decision-applied', 'session-finished'],
          },
        },
      },
    };

    fs.writeFileSync(OUT, `${JSON.stringify(openapi, null, 2)}\n`, 'utf8');
    process.stdout.write(`openapi.json записан: ${Object.keys(shapes).length} схем\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
