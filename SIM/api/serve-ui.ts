/**
 * Запуск сервера для UI: тот же сервер, но с разрешёнными источниками Vite.
 *
 * Список источников не задаётся через переменную окружения в npm-скрипте:
 * на Windows `VAR=x cmd` не работает без отдельной обёртки. Поэтому список
 * задаётся здесь — это единственное отличие от `npm run api`.
 */
import { startApi } from './server.ts';
import { portFromEnv } from './server.ts';
import { parseOrigins } from './cors.ts';

const UI_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

async function main(): Promise<void> {
  const port = portFromEnv();
  const cors = parseOrigins(process.env['SIM_API_ORIGINS'] ?? UI_ORIGINS.join(','));
  const app = await startApi({ port, cors });
  const address = app.server.address();
  const shown = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`Сервер слушает 127.0.0.1:${shown}, источники: ${cors.origins.join(', ')}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
