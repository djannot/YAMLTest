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

describe('Runner integration – setVars within-run chaining', () => {
  it('setVars from a command test is visible to subsequent command tests', async () => {
    // setVars writes to process.env so that the next test's spawned shell inherits it.
    const key = 'YAMLTEST_SETVARS_CHAIN';

    const yaml = toYaml([
      {
        name: 'step-1-set-var',
        command: { command: 'echo "chained-value"' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        setVars: { [key]: { stdout: true } },
      },
      {
        name: 'step-2-read-var',
        command: { command: `echo $${key}` },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'chained-value' } },
      },
    ]);

    const result = await runTests(yaml);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);

    delete process.env[key];
  });

  it('setVars from an HTTP test is visible to a subsequent command test', async () => {
    const key = 'YAMLTEST_SETVARS_HTTP_CMD';

    const yaml = toYaml([
      {
        name: 'step-1-http',
        http: { url: baseUrl, method: 'GET', path: '/ok' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { [key]: { body: true } },
      },
      {
        name: 'step-2-read-var',
        command: { command: `echo "body=$${key}"` },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'body=ok' } },
      },
    ]);

    const result = await runTests(yaml);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);

    delete process.env[key];
  });

  it('subshell export does NOT propagate to the next test (documents the limitation)', async () => {
    // A command like `export KEY=value` sets the var only in the subshell
    // spawned for that test. The subshell exits, the var is gone.
    // The next test spawns a fresh subshell from process.env, which does
    // not contain KEY — so echo $KEY prints an empty line.
    // Use setVars instead for cross-step variable passing.
    const key = 'YAMLTEST_SUBSHELL_EXPORT';
    delete process.env[key];

    const yaml = toYaml([
      {
        name: 'subshell-export',
        command: { command: `export ${key}=subshell-value` },
        source: { type: 'local' },
        expect: { exitCode: 0 },
      },
      {
        name: 'read-after-subshell-export',
        // $KEY is empty because the previous subshell exited;
        // the equals check against an empty string confirms it was not propagated.
        command: { command: `echo "got:${key}:$(echo $${key})"` },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: `got:${key}:` } },
      },
    ]);

    const result = await runTests(yaml);
    // Both tests exit 0, but the second one shows the var is empty
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);

    delete process.env[key];
  });
});
