'use strict';

/**
 * Unit tests for executeTest dispatch logic.
 *
 * Tests YAML parsing, routing, and error cases. Uses a real local HTTP server
 * for HTTP dispatch tests to avoid CJS mock complexity.
 */

import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => server.close());

// ── YAML parsing ──────────────────────────────────────────────────────────────

describe('executeTest – YAML parsing', () => {
  it('throws on invalid YAML', async () => {
    await expect(executeTest('{ unclosed: [')).rejects.toThrow(/Failed to parse test YAML/);
  });

  it('throws on null/empty input', async () => {
    await expect(executeTest('null')).rejects.toThrow();
  });

  it('throws when no recognised test key is present', async () => {
    await expect(
      executeTest(JSON.stringify({ name: 'unknown', source: { type: 'local' } }))
    ).rejects.toThrow(/Unknown test type/);
  });
});

// ── HTTP dispatch ─────────────────────────────────────────────────────────────

describe('executeTest – HTTP dispatch', () => {
  it('dispatches to HTTP handler and returns true on success', async () => {
    const yaml = JSON.stringify({
      http: { url: base, method: 'GET', path: '/' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
    });
    await expect(executeTest(yaml)).resolves.toBe(true);
  });

  it('throws on HTTP status mismatch', async () => {
    const yaml = JSON.stringify({
      http: { url: base, method: 'GET', path: '/' },
      source: { type: 'local' },
      expect: { statusCode: 404 },
    });
    await expect(executeTest(yaml)).rejects.toThrow(/Status code mismatch/);
  });
});

// ── Command dispatch ──────────────────────────────────────────────────────────

describe('executeTest – command dispatch', () => {
  it('dispatches to command handler and returns true on success', async () => {
    const yaml = JSON.stringify({
      command: { command: 'echo hello' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
    });
    await expect(executeTest(yaml)).resolves.toBe(true);
  });

  it('throws when command is a plain string instead of an object', async () => {
    const yaml = JSON.stringify({
      command: 'echo hello',
      source: { type: 'local' },
      expect: { exitCode: 0 },
    });
    await expect(executeTest(yaml)).rejects.toThrow(/Command must be an object/);
  });
});

// ── httpBodyComparison dispatch ───────────────────────────────────────────────

describe('executeTest – httpBodyComparison dispatch', () => {
  it('throws when request1 or request2 is missing', async () => {
    const yaml = JSON.stringify({
      httpBodyComparison: { request1: null, request2: null },
    });
    await expect(executeTest(yaml)).rejects.toThrow(/request1 and request2/);
  });
});
