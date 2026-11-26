import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.resolve(HERE, '..');

export type Zone = 'contract' | 'plant' | 'system' | 'other';

const RANDOM_CALL = ['Math', 'random'].join('.');

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function zoneOf(filePath: string): Zone {
  const relative = path.relative(SIM_ROOT, path.resolve(filePath));
  const top = relative.split(path.sep)[0];
  if (top === 'contract' || top === 'plant' || top === 'system') {
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

/** Правило сборки: Система не импортирует цех, контракт не импортирует ни один мир. */
export function importViolation(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const resolved = path.normalize(path.join(path.dirname(importer), specifier));
  const from = zoneOf(importer);
  const to = zoneOf(resolved);
  if (from === 'system' && to === 'plant') {
    return `модуль Системы импортирует модуль предприятия (${specifier})`;
  }
  if (from === 'plant' && to === 'system') {
    return `модуль предприятия импортирует модуль Системы (${specifier})`;
  }
  if (from === 'contract' && (to === 'plant' || to === 'system')) {
    return `контракт импортирует мир «${to}» (${specifier})`;
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
    for (const specifier of importSpecifiers(source)) {
      const problem = importViolation(file, specifier);
      if (problem) {
        violations.push(`${path.relative(root, file)}: ${problem}`);
      }
    }
  }
  return violations;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const violations = scanBoundary();
  if (violations.length > 0) {
    for (const line of violations) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(1);
  }
}
