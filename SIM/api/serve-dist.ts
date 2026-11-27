/**
 * Сервер для проверки собранного экрана: отдаёт `ui/dist` и API на одном порту.
 * Нужен, чтобы экран можно было открыть без Vite-процесса и без списка источников:
 * страница и API живут на одном хосте, кросс-доменного запроса нет.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startApi } from './server.ts';
import { parseOrigins } from './cors.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'ui', 'dist');

async function main(): Promise<void> {
  const port = Number(process.env['SIM_API_PORT'] ?? 3477);
  const origins = process.env['SIM_API_ORIGINS'];
  const app = await startApi({
    port,
    cors: origins === undefined ? { origins: [] } : parseOrigins(origins),
    statics: { root: DIST },
  });
  process.stdout.write(`Экран и API: http://127.0.0.1:${port}/\n`);
  void app;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
