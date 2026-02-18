'use strict';

/**
 * Integration tests for HTTP test execution.
 *
 * Spins up a real local HTTP server so no mocking is needed.  Tests exercise
 * the full stack: executeTest → executeHttpTest → axios → real TCP connection.
 */

import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';

// ── Local test server ─────────────────────────────────────────────────────────

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = req.url;

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Server': 'test' });
        res.end('healthy');
        return;
      }

      if (url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', user: { id: 42, name: 'Alice' } }));
        return;
      }

      if (url === '/error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }

      if (url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: hello\ndata: world\n');
        return;
      }

      if (url === '/redirect') {
        res.writeHead(301, { Location: '/health' });
        res.end();
        return;
      }

      if (req.method === 'POST' && url === '/echo') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body }));
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaml(obj) {
  return JSON.stringify(obj);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HTTP integration – basic requests', () => {
  it('passes a simple GET 200 check', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/health' },
          source: { type: 'local' },
          expect: { statusCode: 200 },
        })
      )
    ).resolves.toBe(true);
  });

  it('passes bodyContains check', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/health' },
          source: { type: 'local' },
          expect: { statusCode: 200, bodyContains: 'healthy' },
        })
      )
    ).resolves.toBe(true);
  });

  it('fails when status code does not match', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/error' },
          source: { type: 'local' },
          expect: { statusCode: 200 },
        })
      )
    ).rejects.toThrow(/Status code mismatch/);
  });

  it('passes when status code is in an array', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/error' },
          source: { type: 'local' },
          expect: { statusCode: [200, 500] },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('HTTP integration – JSON body validation', () => {
  it('validates a JSON field with bodyJsonPath', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/json' },
          source: { type: 'local' },
          expect: {
            statusCode: 200,
            bodyJsonPath: [{ path: '$.status', comparator: 'equals', value: 'ok' }],
          },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates a nested JSON field with bodyJsonPath', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/json' },
          source: { type: 'local' },
          expect: {
            statusCode: 200,
            bodyJsonPath: [
              { path: '$.user.id', comparator: 'equals', value: 42 },
              { path: '$.user.name', comparator: 'equals', value: 'Alice' },
            ],
          },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates body with bodyRegex', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/json' },
          source: { type: 'local' },
          expect: { statusCode: 200, bodyRegex: '"id":\\s*42' },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('HTTP integration – header validation', () => {
  it('validates a response header value', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/health' },
          source: { type: 'local' },
          expect: {
            statusCode: 200,
            headers: [{ name: 'x-server', comparator: 'equals', value: 'test' }],
          },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates header exists', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/health' },
          source: { type: 'local' },
          expect: {
            statusCode: 200,
            headers: [{ name: 'content-type', comparator: 'exists' }],
          },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('HTTP integration – streaming / SSE response', () => {
  it('checks bodyContains on a streaming-style response', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/stream' },
          source: { type: 'local' },
          expect: { statusCode: 200, bodyContains: 'data:' },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('HTTP integration – POST with body', () => {
  it('sends a POST body and validates the echo', async () => {
    await expect(
      executeTest(
        yaml({
          http: {
            url: baseUrl,
            method: 'POST',
            path: '/echo',
            headers: { 'Content-Type': 'application/json' },
            body: '{"msg":"hello"}',
          },
          source: { type: 'local' },
          expect: { statusCode: 200, bodyContains: 'received' },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('HTTP integration – negated assertions', () => {
  it('passes when body does NOT contain a substring (negated)', async () => {
    await expect(
      executeTest(
        yaml({
          http: { url: baseUrl, method: 'GET', path: '/health' },
          source: { type: 'local' },
          expect: {
            statusCode: 200,
            bodyContains: { value: 'error', negate: true },
          },
        })
      )
    ).resolves.toBe(true);
  });
});
