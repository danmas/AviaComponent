/**
 * Один клиент на приложение. Сессию создаёт только каркас, не экран.
 */
import { createClient } from '../../../api-client/client.ts';

// В сборке экран и API живут на одном хосте. В разработке Vite на 5173, сервер на 3400.
const API_BASE = import.meta.env['VITE_API_BASE']
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:3400' : (globalThis.location?.origin ?? 'http://127.0.0.1:3400'));

export const client = createClient({ baseUrl: API_BASE });
