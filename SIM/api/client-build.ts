/**
 * Сборка клиентского пакета из openapi.json.
 *
 * Типы не пишутся руками: они выводятся из описания, а описание — из ответов сервера.
 * Ручная правка `client.ts` бессмысленна: файл перезаписывается этой командой.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(HERE, '..');
const OPENAPI = path.resolve(SIM_ROOT, 'api', 'openapi.json');
const OUT_DIR = path.resolve(SIM_ROOT, 'api-client');

type Any = Record<string, unknown>;

interface Schema {
  readonly type?: string;
  readonly properties?: Record<string, Schema>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly nullable?: boolean;
}

interface OpenApi {
  readonly components?: { readonly schemas?: Record<string, Schema> };
  readonly paths?: Record<string, unknown>;
}

function isPlain(value: unknown): value is Any {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Имя поля в TypeScript: идентификатор как есть, иначе — в кавычках. */
function fieldName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** TypeScript-тип из схемы. */
function typeOf(schema: Schema, indent: string): string {
  if (schema.enum !== undefined) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  const base = ((): string => {
    switch (schema.type) {
      case 'object': {
        const properties = schema.properties ?? {};
        const required = new Set(schema.required ?? []);
        const lines = Object.entries(properties).map(([key, child]) => {
          const optional = required.has(key) || child.nullable === true ? '' : '?';
          return `${indent}  readonly ${fieldName(key)}${optional}: ${typeOf(child, `${indent}  `)};`;
        });
        return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('\n')}\n${indent}}`;
      }
      case 'array': {
        const items = schema.items ?? {};
        const inner = typeOf(items, indent);
        return Object.keys(items).length === 0 ? 'readonly unknown[]' : `readonly ${inner}[]`;
      }
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'string':
        return 'string';
      default:
        return 'unknown';
    }
  })();
  return schema.nullable === true && base !== 'null' ? `${base} | null` : base;
}

function main(): void {
  if (!fs.existsSync(OPENAPI)) {
    process.stderr.write('openapi.json не найден: сначала npm run openapi\n');
    process.exit(1);
  }
  const api = JSON.parse(fs.readFileSync(OPENAPI, 'utf8')) as OpenApi;
  const schemas = api.components?.schemas ?? {};

  const blocks: string[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    blocks.push(`/** Схема \`${name}\` из openapi.json. */\nexport type ${name} = ${typeOf(schema, '')};`);
  }

  const header = [
    '// СГЕНЕРИРОВАНО. Не редактировать руками: npm run api-client',
    '// Источник: api/openapi.json, а он — из фактических ответов сервера.',
    '',
  ].join('\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.resolve(OUT_DIR, 'types.ts'), `${header}${blocks.join('\n\n')}\n`, 'utf8');

  const names = Object.keys(schemas);
  const index = [
    header,
    `export type { ${names.join(', ')} } from './types.ts';`,
    "export { createClient } from './client.ts';",
    "export type { ClientOptions, Transport } from './client.ts';",
    '',
  ].join('\n');
  fs.writeFileSync(path.resolve(OUT_DIR, 'index.ts'), index, 'utf8');

  process.stdout.write(`api-client/types.ts: ${names.length} типов (${names.join(', ')})\n`);
}

main();
