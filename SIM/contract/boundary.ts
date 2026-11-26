import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(HERE, '..');

export type Zone = 'contract' | 'plant' | 'system' | 'api' | 'api-client' | 'other';

const RANDOM_CALL = ['Math', 'random'].join('.');

const HTTP_LIBRARIES = new Set(['fastify', 'express', 'node:http', 'node:https']);

function isHttpLibrary(specifier: string): boolean {
  return HTTP_LIBRARIES.has(specifier) || specifier.startsWith('@fastify/');
}

function topFolder(filePath: string, root: string): string {
  const relative = path.relative(root, path.resolve(filePath));
  return relative.split(path.sep)[0] ?? '';
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function zoneOf(filePath: string, root = SIM_ROOT): Zone {
  const top = topFolder(filePath, root);
  if (top === 'contract' || top === 'plant' || top === 'system' || top === 'api' || top === 'api-client') {
    return top;
  }
  return 'other';
}

export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      found.push(specifier);
    }
  }
  for (const match of source.matchAll(DYNAMIC_RE)) {
    const specifier = match[1];
    if (specifier) {
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Система не импортирует цех. Контракт не импортирует миры.
 * Ядро не импортирует сервер и HTTP-библиотеки. Каталог test/ — проверка, не ядро.
 */
export function importViolation(importer: string, specifier: string, root = SIM_ROOT): string | null {
  const from = zoneOf(importer, root);
  if (isHttpLibrary(specifier) && (from === 'plant' || from === 'system' || from === 'contract')) {
    return `модуль «${from}» импортирует HTTP-библиотеку (${specifier})`;
  }
  // Клиент ходит к серверу по сети, а не импортом: библиотека транспорта ему закрыта.
  if (from === 'api-client' && (isHttpLibrary(specifier) || specifier === 'ws' || specifier === 'react')) {
    return `клиент импортирует библиотеку транспорта (${specifier})`;
  }
  if (!specifier.startsWith('.')) {
    return null;
  }
  const resolved = path.normalize(path.join(path.dirname(importer), specifier));
  const to = zoneOf(resolved, root);
  if (from === 'system' && to === 'plant') {
    return `модуль Системы импортирует модуль предприятия (${specifier})`;
  }
  if (from === 'plant' && to === 'system') {
    return `модуль предприятия импортирует модуль Системы (${specifier})`;
  }
  if (from === 'contract' && (to === 'plant' || to === 'system' || to === 'api' || to === 'api-client')) {
    return `контракт импортирует мир «${to}» (${specifier})`;
  }
  // Клиент ходит к серверу по сети, а не импортом: серверный рантайм ему закрыт.
  // Типы контракта у клиента свои, сгенерированные из openapi.json.
  if (from === 'api-client' && (to === 'api' || to === 'plant' || to === 'system')) {
    return `клиент импортирует серверный модуль «${to}» (${specifier})`;
  }
  if (from === 'api-client' && isHttpLibrary(specifier)) {
    return `клиент импортирует библиотеку транспорта (${specifier})`;
  }
  if (to === 'api' && from !== 'api') {
    const top = topFolder(importer, root);
    // Тесты (в том числе тесты UI) вправе поднимать сервер: им нужен реальный срез, а не мок.
    if (from === 'other' && (top === 'test' || top === 'ui')) {
      return null;
    }
    return `модуль «${from}» импортирует серверный модуль (${specifier})`;
  }
  return null;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'fixtures') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

export function scanBoundary(root = SIM_ROOT): string[] {
  const violations: string[] = [];
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(RANDOM_CALL)) {
      violations.push(`${path.relative(root, file)}: вызов ${RANDOM_CALL}`);
    }
    const zone = zoneOf(file);
    if (zone === 'api' && hasEnum(source)) {
      violations.push(`${path.relative(root, file)}: конструкция enum в серверной зоне`);
    }
    for (const specifier of importSpecifiers(source)) {
      const problem = importViolation(file, specifier, root);
      if (problem) {
        violations.push(`${path.relative(root, file)}: ${problem}`);
      }
    }
  }
  return violations;
}

/**
 * strip-only режим Node не поддерживает enum: сервер обязан жить на `as const`
 * и union-типах, иначе `npm run api` потребует сборки.
 */
export function hasEnum(source: string): boolean {
  return /(^|\n)\s*(export\s+)?(const\s+)?enum\s+[A-Za-z_$]/.test(source);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const arg = process.argv[2];
  const root = arg === undefined || arg === '' ? SIM_ROOT : path.resolve(arg);
  const violations = scanBoundary(root);
  if (violations.length > 0) {
    for (const line of violations) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(1);
  }
}
