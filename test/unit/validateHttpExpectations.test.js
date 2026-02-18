'use strict';

/**
 * Unit tests for HTTP expectation validation.
 *
 * Uses a real in-process HTTP server (no axios mocking needed) so that the
 * full core.js expectation pipeline is exercised without CJS mock complexity.
 */

import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const routes = {
        '/200':        [200, {}, 'OK'],
        '/201':        [201, {}, 'Created'],
        '/404':        [404, {}, 'Not Found'],
        '/500':        [500, {}, 'Server Error'],
        '/body-data':  [200, { 'content-type': 'text/plain' }, 'data: hello world'],
        '/body-clean': [200, { 'content-type': 'text/plain' }, 'everything is fine'],
        '/body-error': [200, { 'content-type': 'text/plain' }, 'fatal error occurred'],
        '/user-num':   [200, { 'content-type': 'application/json' }, JSON.stringify({ user: { id: 12345 } })],
        '/json':       [200, { 'content-type': 'application/json' }, JSON.stringify({ user: { id: 42 }, status: 'ok' })],
        '/json-bad':   [200, { 'content-type': 'application/json' }, JSON.stringify({ other: 'data' })],
        '/hdr':        [200, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'abc' }, 'ok'],
      };
      const entry = routes[req.url];
      if (entry) {
        const [status, headers, body] = entry;
        res.writeHead(status, headers);
        res.end(body);
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => server.close());

const httpTest = (path, expect_) => JSON.stringify({
  http: { url: base, method: 'GET', path },
  source: { type: 'local' },
  expect: expect_,
});

// ── Status code ───────────────────────────────────────────────────────────────

describe('validateHttpExpectations – statusCode', () => {
  it('passes when status code matches', async () => {
    await expect(executeTest(httpTest('/200', { statusCode: 200 }))).resolves.toBe(true);
  });

  it('throws when status code does not match', async () => {
    await expect(executeTest(httpTest('/404', { statusCode: 200 }))).rejects.toThrow(/Status code mismatch/);
  });

  it('passes when code is in an accepted array', async () => {
    await expect(executeTest(httpTest('/201', { statusCode: [200, 201, 202] }))).resolves.toBe(true);
  });

  it('throws when code is not in the accepted array', async () => {
    await expect(executeTest(httpTest('/500', { statusCode: [200, 201] }))).rejects.toThrow(/Status code mismatch/);
  });
});

// ── bodyContains ──────────────────────────────────────────────────────────────

describe('validateHttpExpectations – bodyContains', () => {
  it('passes when body contains the substring', async () => {
    await expect(executeTest(httpTest('/body-data', { statusCode: 200, bodyContains: 'data:' }))).resolves.toBe(true);
  });

  it('throws when body does not contain substring', async () => {
    await expect(executeTest(httpTest('/body-clean', { statusCode: 200, bodyContains: 'data:' }))).rejects.toThrow(/does not contain substring/);
  });

  it('passes with an array of bodyContains', async () => {
    await expect(executeTest(httpTest('/body-data', { statusCode: 200, bodyContains: ['data:', 'hello'] }))).resolves.toBe(true);
  });

  it('throws when one item in the array is absent', async () => {
    await expect(executeTest(httpTest('/body-clean', { statusCode: 200, bodyContains: ['fine', 'missing'] }))).rejects.toThrow(/does not contain substring/);
  });

  it('passes negated bodyContains when substring absent', async () => {
    await expect(executeTest(httpTest('/body-clean', { statusCode: 200, bodyContains: { value: 'error', negate: true } }))).resolves.toBe(true);
  });

  it('throws negated bodyContains when substring present', async () => {
    await expect(executeTest(httpTest('/body-error', { statusCode: 200, bodyContains: { value: 'error', negate: true } }))).rejects.toThrow(/should not contain/);
  });
});

// ── bodyRegex ─────────────────────────────────────────────────────────────────

describe('validateHttpExpectations – bodyRegex', () => {
  it('passes when body matches regex', async () => {
    await expect(executeTest(httpTest('/user-num', { statusCode: 200, bodyRegex: '"id":\\d+' }))).resolves.toBe(true);
  });

  it('throws when body does not match regex', async () => {
    await expect(executeTest(httpTest('/body-clean', { statusCode: 200, bodyRegex: '^\\d+$' }))).rejects.toThrow(/does not match regex/);
  });

  it('supports negated bodyRegex', async () => {
    await expect(executeTest(httpTest('/body-clean', { statusCode: 200, bodyRegex: { value: 'error', negate: true } }))).resolves.toBe(true);
  });
});

// ── bodyJsonPath ──────────────────────────────────────────────────────────────

describe('validateHttpExpectations – bodyJsonPath', () => {
  it('passes when JSONPath value matches', async () => {
    await expect(executeTest(httpTest('/json', {
      statusCode: 200,
      bodyJsonPath: [{ path: '$.user.id', comparator: 'equals', value: 42 }],
    }))).resolves.toBe(true);
  });

  it('throws when JSONPath value does not match', async () => {
    await expect(executeTest(httpTest('/json', {
      statusCode: 200,
      bodyJsonPath: [{ path: '$.user.id', comparator: 'equals', value: 99 }],
    }))).rejects.toThrow();
  });

  it('throws when JSONPath yields no results', async () => {
    await expect(executeTest(httpTest('/json-bad', {
      statusCode: 200,
      bodyJsonPath: [{ path: '$.user.id', comparator: 'exists' }],
    }))).rejects.toThrow(/did not return any results/);
  });
});

// ── headers ───────────────────────────────────────────────────────────────────

describe('validateHttpExpectations – headers', () => {
  it('passes when header contains expected value', async () => {
    await expect(executeTest(httpTest('/hdr', {
      statusCode: 200,
      headers: [{ name: 'content-type', comparator: 'contains', value: 'application/json' }],
    }))).resolves.toBe(true);
  });

  it('throws when expected header is absent', async () => {
    await expect(executeTest(httpTest('/200', {
      statusCode: 200,
      headers: [{ name: 'x-missing', comparator: 'exists' }],
    }))).rejects.toThrow();
  });

  it('passes exists check when header is present', async () => {
    await expect(executeTest(httpTest('/hdr', {
      statusCode: 200,
      headers: [{ name: 'x-request-id', comparator: 'exists' }],
    }))).resolves.toBe(true);
  });
});
