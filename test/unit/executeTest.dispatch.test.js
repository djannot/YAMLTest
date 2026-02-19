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

// ── setVars validation ────────────────────────────────────────────────────────

describe('executeTest – setVars requires expect', () => {
  it('throws when HTTP test has setVars without expect', async () => {
    const yaml = JSON.stringify({
      http: { url: base, method: 'GET', path: '/' },
      source: { type: 'local' },
      setVars: { TOKEN: { body: true } },
    });
    await expect(executeTest(yaml)).rejects.toThrow(/setVars requires "expect"/);
  });

  it('throws when command test has setVars without expect', async () => {
    const yaml = JSON.stringify({
      command: { command: 'echo hello' },
      source: { type: 'local' },
      setVars: { OUT: { stdout: true } },
    });
    await expect(executeTest(yaml)).rejects.toThrow(/setVars requires "expect"/);
  });

  it('passes setVars through to HTTP handler on success', async () => {
    const key = 'DISPATCH_HTTP_BODY';
    const yaml = JSON.stringify({
      http: { url: base, method: 'GET', path: '/' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { [key]: { body: true } },
    });
    await expect(executeTest(yaml)).resolves.toBe(true);
    expect(process.env[key]).toBe('ok');
    delete process.env[key];
  });

  it('passes setVars through to command handler on success', async () => {
    const key = 'DISPATCH_CMD_OUT';
    const yaml = JSON.stringify({
      command: { command: 'echo dispatch-test' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { [key]: { stdout: true } },
    });
    await expect(executeTest(yaml)).resolves.toBe(true);
    expect(process.env[key]).toBe('dispatch-test');
    delete process.env[key];
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
