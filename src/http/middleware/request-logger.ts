import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../../logger.js';

// An incoming X-Request-Id is reused only if it is short and plain (no log injection).
const INCOMING_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Assigns a request id (echoed as X-Request-Id) and logs one line per request. */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId(req: IncomingMessage, res: ServerResponse) {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && INCOMING_ID_RE.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Health is polled by the container healthcheck; logging it would drown everything else.
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  });
}
