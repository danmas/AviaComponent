/**
 * Проверка границы UI: приложение ходит только через api-client.
 *
 * Запрещено: импорт ядра, сервера и собственный транспорт (`fetch`, `WebSocket`,
 * библиотеки HTTP). Разрешено: `api-client`, собственные модули, React.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = HERE;
const SIM_ROOT = path.resolve(HERE, '..');

const FORBIDDEN_IMPORT = [
  { pattern: /\.\.\/\.\.\/(plant|system|contract|api)\//, reason: 'импорт ядра или сервера' },
  { pattern: /\.\.\/(plant|system|contract|api)\//, reason: 'импорт ядра или сервера' },
  { pattern: /^(fastify|@fastify|ws)$/, reason: 'библиотека транспорта' },
];

const FORBIDDEN_CALL = [
  { pattern: /\bfetch\s*\(/, reason: 'собственный запрос вместо api-client' },
  { pattern: /new\s+WebSocket\s*\(/, reason: 'собственное соединение вместо api-client' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'собственный запрос вместо api-client' },
];

const ALLOWED_FILES = new Set(['check-ui.ts']);

/**
 * Тесты живут рядом с приложением и обращаются к серверу напрямую:
 * им нужен реальный срез, а не мок. Это не приложение, и в сборку они не попадают.
 */
function isTestFile(relative: string): boolean {
  return relative.startsWith('test/') || relative.startsWith('test\\');
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

export function violationsIn(source: string, file: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
    const specifier = match[1] ?? '';
    for (const rule of FORBIDDEN_IMPORT) {
      if (rule.pattern.test(specifier)) {
        found.push(`${file}: ${rule.reason} (${specifier})`);
      }
    }
  }
  for (const rule of FORBIDDEN_CALL) {
    if (rule.pattern.test(source)) {
      found.push(`${file}: ${rule.reason}`);
    }
  }
  return found;
}

export function scanUi(root = UI_ROOT): string[] {
  const violations: string[] = [];
  for (const file of walk(root)) {
    const relative = path.relative(root, file);
    if (ALLOWED_FILES.has(relative.replace(/\\/g, '/')) || isTestFile(relative)) {
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    violations.push(...violationsIn(source, relative));
  }
  return violations;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const violations = scanUi(UI_ROOT);
  if (violations.length > 0) {
    for (const line of violations) {
      process.stderr.write(`${line}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`UI: граница чистая (${walk(UI_ROOT).length} файлов)\n`);
}

export { SIM_ROOT };
