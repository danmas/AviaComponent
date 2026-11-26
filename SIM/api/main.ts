import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { portFromEnv, startApi } from './server.ts';

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

export async function main(): Promise<void> {
  const port = portFromEnv();
  const app = await startApi({ port });
  const address = app.server.address();
  const shown = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`Сервер слушает 127.0.0.1:${shown}\n`);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
