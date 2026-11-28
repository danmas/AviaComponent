import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

import { decideCors, originFromEnv, type CorsConfig } from './cors.ts';
import {
  ApiError,
  createSessionStore,
  type CreateSessionInput,
  type DecisionInput,
  type Sender,
  type SessionStore,
} from './sessions.ts';
import { replayWithinWindow, trimToWindow, type WindowExceeded } from './stream.ts';
import { SUPPORTED_VERSIONS, VERSION_PREFIX, pathV1, unknownVersionBody, versioned } from './version.ts';

export const DEFAULT_PORT = 3400;

export class PortBusyError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`Порт ${port} занят. Сервер остановлен.`);
    this.name = 'PortBusyError';
    this.port = port;
  }
}

export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SIM_API_PORT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`SIM_API_PORT должен быть целым номером порта, получено «${raw}».`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`SIM_API_PORT должен быть целым номером порта, получено «${raw}».`);
  }
  return port;
}

const anyObject = { type: 'object', additionalProperties: true };
const errorBody = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
};

function readShift(query: unknown): number | undefined {
  if (query === null || typeof query !== 'object' || !('shift' in query)) {
    return undefined;
  }
  const shift = (query as { shift?: unknown }).shift;
  if (shift === undefined) {
    return undefined;
  }
  if (typeof shift !== 'string' || !/^[0-9]+$/.test(shift)) {
    throw new ApiError(400, 'Номер смены — целое число от нуля.');
  }
  return Number(shift);
}

function isAddrInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE';
}

export async function buildApp(
  store: SessionStore = createSessionStore(),
  cors: CorsConfig = { origins: [] },
  statics?: { readonly root: string },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // CORS: разрешающий заголовок только для источников из списка.
  app.addHook('onRequest', async (request, reply) => {
    const decision = decideCors(cors, request.headers.origin);
    if (decision.allowOrigin !== null) {
      void reply.header('Access-Control-Allow-Origin', decision.allowOrigin);
      void reply.header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      void reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      void reply.header('Access-Control-Allow-Headers', 'Content-Type');
      return reply.status(204).send();
    }
    return undefined;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(versioned({ error: error.message }));
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const message = error instanceof Error ? error.message : 'Запрос отклонён.';
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(versioned({ error: message }));
    }
    return reply.status(500).send(versioned({ error: 'Внутренняя ошибка сервера.' }));
  });

  // Ошибки из обработчиков маршрутов Fastify отдаёт через этот же handler,
  // но ApiError, брошенный внутри async-обработчика, доходит сюда как есть.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode < 400) {
      return payload;
    }
    const body = payload as unknown;
    if (typeof body !== 'string') {
      return payload;
    }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed['apiVersion'] !== undefined) {
        return payload;
      }
      return JSON.stringify(versioned(parsed));
    } catch {
      return payload;
    }
  });

  // Неизвестная версия адресована другой версии, а не сломана: 404, не 400.
  app.setNotFoundHandler((request, reply) => {
    const prefix = `/${request.url.split('?')[0]?.split('/')[1] ?? ''}`;
    if (prefix !== VERSION_PREFIX && /^\/v[0-9]+(\/|$)/.test(request.url)) {
      return reply.status(404).send(unknownVersionBody());
    }
    return reply.status(404).send(versioned({ error: 'Маршрут не найден.', supported: [...SUPPORTED_VERSIONS] }));
  });

  app.post(pathV1('/sessions'), {
    schema: {
      body: {
        type: 'object',
        required: ['seed', 'level', 'overlay'],
        additionalProperties: false,
        properties: {
          seed: { type: 'integer' },
          level: { type: 'string' },
          overlay: { type: 'string' },
          horizonShifts: { type: 'integer' },
        },
      },
      response: { 201: anyObject, 400: errorBody },
    },
  }, async (request, reply) => {
    const body = request.body as CreateSessionInput;
    const input: CreateSessionInput = { seed: body.seed, level: body.level, overlay: body.overlay };
    const created = body.horizonShifts === undefined
      ? store.create(input)
      : store.create({ ...input, horizonShifts: body.horizonShifts });
    return reply.status(201).send(versioned(created));
  });

  app.get(pathV1('/sessions/:id'), {
    schema: { response: { 200: anyObject, 400: errorBody, 404: errorBody } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return versioned(store.view(id, readShift(request.query)));
  });

  app.get(pathV1('/sessions/:id/shop'), {
    schema: { response: { 200: anyObject, 400: errorBody, 404: errorBody } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return versioned(store.shop(id, readShift(request.query)));
  });

  app.get(pathV1('/sessions/:id/roles'), {
    schema: { response: { 200: anyObject, 400: errorBody, 404: errorBody } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return versioned(store.roles(id, readShift(request.query)));
  });

  app.get(pathV1('/sessions/:id/trace'), {
    schema: { response: { 200: anyObject, 404: errorBody } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return versioned(store.trace(id));
  });

  app.post(pathV1('/sessions/:id/decisions'), {
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          batchId: { type: 'string' },
          rank: { type: 'integer' },
          orderId: { type: 'string' },
          appliedAt: { type: 'integer' },
        },
      },
      response: { 200: anyObject, 400: errorBody, 404: errorBody, 409: errorBody },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      type: string;
      batchId?: string;
      rank?: number;
      orderId?: string;
      appliedAt?: number;
    };
    const input: DecisionInput = {
      type: body.type,
      ...(body.batchId === undefined ? {} : { batchId: body.batchId }),
      ...(body.rank === undefined ? {} : { rank: body.rank }),
      ...(body.orderId === undefined ? {} : { orderId: body.orderId }),
      ...(body.appliedAt === undefined ? {} : { appliedAt: body.appliedAt }),
    };
    return versioned(store.decide(id, input));
  });

  app.post(pathV1('/sessions/:id/advance'), {
    schema: { response: { 200: anyObject, 404: errorBody, 409: errorBody } },
  }, async (request) => versioned(store.advance((request.params as { id: string }).id)));

  app.get(pathV1('/sessions/:id/stream'), { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { lastSeq?: unknown };
    const sender: Sender = {
      send(data: string) {
        socket.send(data);
      },
    };
    const rawSeq = query.lastSeq;
    let lastSeq = 0;
    if (typeof rawSeq === 'string' && rawSeq !== '') {
      if (!/^[0-9]+$/.test(rawSeq)) {
        socket.send(JSON.stringify(versioned({ error: 'lastSeq — целое число от нуля.' })));
        socket.close();
        return;
      }
      lastSeq = Number(rawSeq);
    }
    try {
      const replay = store.replay(id, lastSeq);
      const exceeded: WindowExceeded | null = replay.exceeded;
      if (exceeded !== null) {
        socket.send(JSON.stringify(versioned(exceeded)));
        socket.close();
        return;
      }
      for (const event of replay.events) {
        socket.send(JSON.stringify(versioned(event)));
      }
      store.attach(id, sender, lastSeq, { replay: false });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Сессия не найдена.';
      socket.send(JSON.stringify(versioned({ error: message })));
      socket.close();
      return;
    }
    socket.on('close', () => {
      store.detach(id, sender);
    });
    socket.on('message', (raw: unknown) => {
      let body: unknown;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        body = JSON.parse(text);
      } catch {
        socket.send(JSON.stringify(versioned({ error: 'Сообщение не JSON.' })));
        return;
      }
      if (body === null || typeof body !== 'object' || (body as { type?: unknown }).type !== 'advance') {
        socket.send(JSON.stringify(versioned({ error: 'Ожидается сообщение { "type": "advance" }.' })));
        return;
      }
      try {
        store.advance(id);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Внутренняя ошибка сервера.';
        socket.send(JSON.stringify(versioned({ error: message })));
      }
    });
  });

  // Раздача собранного экрана — до ready(): Fastify не даёт добавлять маршруты
  // после того, как приложение объявлено готовым.
  if (statics !== undefined) {
    const indexFile = path.join(statics.root, 'index.html');
    const assetsDir = path.join(statics.root, 'assets');
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    app.get('/', (_request, reply) => {
      if (!fs.existsSync(indexFile)) {
        return reply.status(404).send(versioned({ error: 'сборка экрана не найдена: нужен vite build' }));
      }
      return reply.type(mime['.html'] ?? 'text/html').send(fs.readFileSync(indexFile, 'utf8'));
    });
    app.get('/assets/*', (request, reply) => {
      const relative = (request.params as Record<string, string>)['*'] ?? '';
      const file = path.join(assetsDir, relative);
      if (!file.startsWith(assetsDir) || !fs.existsSync(file)) {
        return reply.status(404).send(versioned({ error: 'нет такого файла' }));
      }
      return reply.type(mime[path.extname(file)] ?? 'application/octet-stream').send(fs.readFileSync(file));
    });
  }

  await app.ready();
  return app;
}

export async function startApi(options: {
  port: number;
  host?: string;
  store?: SessionStore;
  cors?: CorsConfig;
  statics?: { readonly root: string };
}): Promise<FastifyInstance> {
  const app = await buildApp(
    options.store ?? createSessionStore(),
    options.cors ?? originFromEnv(),
    options.statics,
  );
  const host = options.host ?? '127.0.0.1';
  try {
    await app.listen({ port: options.port, host });
  } catch (error) {
    await app.close();
    if (isAddrInUse(error)) {
      throw new PortBusyError(options.port);
    }
    throw error;
  }
  return app;
}
