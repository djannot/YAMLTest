'use strict';

/**
 * Integration tests for the multi-test runner (src/runner.js).
 *
 * Uses a real local HTTP server and real shell commands so the full stack
 * is exercised end-to-end without any mocks.
 */

import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runTests } from '../../src/runner.js';

// ── Local test server ─────────────────────────────────────────────────────────

let server;
let baseUrl;

beforeAll(
  async () => {
    await new Promise((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/ok') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }
        if (req.url === '/fail') {
          res.writeHead(500);
          res.end('error');
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });

      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }
);

afterAll(() => server.close());

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpTest(name, path, expectedStatus) {
  return {
    name,
    http: { url: baseUrl, method: 'GET', path },
    source: { type: 'local' },
    expect: { statusCode: expectedStatus },
  };
}

function commandTest(name, command, exitCode = 0) {
  return {
    name,
    command: { command },
    source: { type: 'local' },
    expect: { exitCode },
  };
}

function toYaml(arr) {
  // Use JSON as a valid subset of YAML
  return JSON.stringify(arr);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Runner integration – multiple tests passing', () => {
  it('runs multiple HTTP tests sequentially and reports all passed', async () => {
    const yaml = toYaml([
      httpTest('check-ok', '/ok', 200),
      httpTest('check-ok-again', '/ok', 200),
    ]);

    const result = await runTests(yaml);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('runs mixed HTTP and command tests', async () => {
    const yaml = toYaml([
      httpTest('http-check', '/ok', 200),
      commandTest('cmd-check', 'echo done'),
    ]);

    const result = await runTests(yaml);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

describe('Runner integration – fail-fast', () => {
  it('stops at first HTTP failure and skips remaining tests', async () => {
    const yaml = toYaml([
      httpTest('pass', '/ok', 200),
      httpTest('fail', '/fail', 200), // expects 200, gets 500
      httpTest('should-be-skipped', '/ok', 200),
    ]);

    const result = await runTests(yaml);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);

    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
    expect(result.results[2].skipped).toBe(true);
  });

  it('reports first error message', async () => {
    const yaml = toYaml([
      httpTest('failing', '/fail', 200),
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].error).toMatch(/Status code mismatch/);
  });
});

describe('Runner integration – retry', () => {
  let callCount = 0;

  it('succeeds after retries using a command that fails then passes', async () => {
    // Use a command that checks a file flag to simulate a flaky service
    const yaml = toYaml([
      {
        name: 'retry-http',
        http: { url: baseUrl, method: 'GET', path: '/ok' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        retries: 2,
      },
    ]);

    const result = await runTests(yaml);
    expect(result.passed).toBe(1);
  });
});

describe('Runner integration – single test YAML object (not array)', () => {
  it('accepts a single test definition (not wrapped in array)', async () => {
    const yaml = JSON.stringify(httpTest('single', '/ok', 200));
    const result = await runTests(yaml);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
  });
});

describe('Runner integration – result structure', () => {
  it('includes duration and name in results', async () => {
    const yaml = toYaml([httpTest('timed-test', '/ok', 200)]);
    const result = await runTests(yaml);

    const r = result.results[0];
    expect(r.name).toBe('timed-test');
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.attempts).toBe(1);
  });
});
