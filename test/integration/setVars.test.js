'use strict';

/**
 * Integration tests for the setVars feature.
 *
 * Spins up a real local HTTP server and runs real shell commands to exercise
 * the full setVars pipeline: extract values from one test step, store them
 * in process.env, and use them in subsequent steps via ${VAR} syntax.
 *
 * Covers all extraction sources for http and command test types, plus
 * cross-type chaining (http→command, command→http, command→command, http→http).
 */

import http from 'http';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { executeTest } from '../../src/index.js';
import { runTests } from '../../src/runner.js';

// ── Local test server ─────────────────────────────────────────────────────────

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Server': 'test-server' });
        res.end('healthy');
        return;
      }

      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-42' });
        res.end(JSON.stringify({ status: 'ok', user: { id: 42, name: 'Alice' }, token: 'secret-token-xyz' }));
        return;
      }

      if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><input name="csrf" value="csrf-abc-123"/></html>');
        return;
      }

      if (req.url === '/check-auth') {
        const auth = req.headers['authorization'];
        if (auth === 'Bearer secret-token-xyz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ authenticated: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ authenticated: false, received: auth || 'none' }));
        }
        return;
      }

      if (req.url === '/check-key') {
        const key = req.headers['x-api-key'];
        if (key === 'my-secret-key') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('authorized');
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('forbidden');
        }
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
});

afterAll(() => server.close());

// Track env vars for cleanup
const trackedVars = [];

afterEach(() => {
  for (const key of trackedVars) {
    delete process.env[key];
  }
  trackedVars.length = 0;
});

function trackVars(...names) {
  trackedVars.push(...names);
}

function yaml(obj) {
  return JSON.stringify(obj);
}

function toYaml(arr) {
  return JSON.stringify(arr);
}

// ── HTTP setVars: jsonPath ────────────────────────────────────────────────────

describe('setVars integration – HTTP jsonPath', () => {
  it('extracts a value via jsonPath and stores it in process.env', async () => {
    trackVars('SV_TOKEN');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/json' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_TOKEN: { jsonPath: '$.token' } },
    }));
    expect(process.env.SV_TOKEN).toBe('secret-token-xyz');
  });
});

// ── HTTP setVars: header ──────────────────────────────────────────────────────

describe('setVars integration – HTTP header', () => {
  it('extracts a response header value', async () => {
    trackVars('SV_SERVER');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_SERVER: { header: 'X-Server' } },
    }));
    expect(process.env.SV_SERVER).toBe('test-server');
  });
});

// ── HTTP setVars: statusCode ──────────────────────────────────────────────────

describe('setVars integration – HTTP statusCode', () => {
  it('captures the HTTP status code', async () => {
    trackVars('SV_CODE');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_CODE: { statusCode: true } },
    }));
    expect(process.env.SV_CODE).toBe('200');
  });
});

// ── HTTP setVars: body ────────────────────────────────────────────────────────

describe('setVars integration – HTTP body', () => {
  it('captures the full response body (plain text)', async () => {
    trackVars('SV_BODY');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_BODY: { body: true } },
    }));
    expect(process.env.SV_BODY).toBe('healthy');
  });
});

// ── HTTP setVars: regex ───────────────────────────────────────────────────────

describe('setVars integration – HTTP regex', () => {
  it('extracts via regex capture group from HTML body', async () => {
    trackVars('SV_CSRF');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/html' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_CSRF: { regex: { pattern: 'value="([^"]+)"', group: 1 } } },
    }));
    expect(process.env.SV_CSRF).toBe('csrf-abc-123');
  });

  it('extracts from JSON body using regex', async () => {
    trackVars('SV_USER_ID');
    await executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/json' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      setVars: { SV_USER_ID: { regex: { pattern: '"id":(\\d+)', group: 1 } } },
    }));
    expect(process.env.SV_USER_ID).toBe('42');
  });
});

// ── Command setVars: stdout ───────────────────────────────────────────────────

describe('setVars integration – Command stdout', () => {
  it('captures full stdout from a command', async () => {
    trackVars('SV_CMD_OUT');
    await executeTest(yaml({
      command: { command: 'echo "hello-from-command"' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { SV_CMD_OUT: { stdout: true } },
    }));
    expect(process.env.SV_CMD_OUT).toBe('hello-from-command');
  });
});

// ── Command setVars: stderr ───────────────────────────────────────────────────

describe('setVars integration – Command stderr', () => {
  it('captures stderr from a command', async () => {
    trackVars('SV_CMD_ERR');
    await executeTest(yaml({
      command: { command: 'echo "warn-message" >&2' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { SV_CMD_ERR: { stderr: true } },
    }));
    expect(process.env.SV_CMD_ERR).toBe('warn-message');
  });
});

// ── Command setVars: exitCode ─────────────────────────────────────────────────

describe('setVars integration – Command exitCode', () => {
  it('captures exit code from a command', async () => {
    trackVars('SV_EXIT');
    await executeTest(yaml({
      command: { command: 'exit 2' },
      source: { type: 'local' },
      expect: { exitCode: 2 },
      setVars: { SV_EXIT: { exitCode: true } },
    }));
    expect(process.env.SV_EXIT).toBe('2');
  });
});

// ── Command setVars: jsonPath ─────────────────────────────────────────────────

describe('setVars integration – Command jsonPath', () => {
  it('extracts from parsed JSON stdout', async () => {
    trackVars('SV_PORT');
    await executeTest(yaml({
      command: { command: 'echo \'{"port": 8080, "host": "localhost"}\'', parseJson: true },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { SV_PORT: { jsonPath: '$.port' } },
    }));
    expect(process.env.SV_PORT).toBe('8080');
  });
});

// ── Command setVars: regex from stdout ────────────────────────────────────────

describe('setVars integration – Command regex', () => {
  it('extracts from stdout via regex', async () => {
    trackVars('SV_PID');
    await executeTest(yaml({
      command: { command: 'echo "Process started with PID 12345"' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { SV_PID: { regex: { source: 'stdout', pattern: 'PID (\\d+)', group: 1 } } },
    }));
    expect(process.env.SV_PID).toBe('12345');
  });

  it('extracts from stderr via regex', async () => {
    trackVars('SV_WARN_CODE');
    await executeTest(yaml({
      command: { command: 'echo "WARNING: code=99" >&2' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
      setVars: { SV_WARN_CODE: { regex: { source: 'stderr', pattern: 'code=(\\d+)', group: 1 } } },
    }));
    expect(process.env.SV_WARN_CODE).toBe('99');
  });
});

// ── Cross-type chaining: HTTP → HTTP ──────────────────────────────────────────

describe('setVars integration – HTTP → HTTP chaining', () => {
  it('captures token from login, uses it in authenticated request', async () => {
    trackVars('SV_AUTH_TOKEN');
    const result = await runTests(toYaml([
      {
        name: 'login',
        http: { url: baseUrl, method: 'GET', path: '/json' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_AUTH_TOKEN: { jsonPath: '$.token' } },
      },
      {
        name: 'access-protected',
        http: {
          url: baseUrl,
          method: 'GET',
          path: '/check-auth',
          headers: { Authorization: 'Bearer ${SV_AUTH_TOKEN}' },
        },
        source: { type: 'local' },
        expect: { statusCode: 200, bodyContains: 'true' },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Cross-type chaining: HTTP → Command ───────────────────────────────────────

describe('setVars integration – HTTP → Command chaining', () => {
  it('captures user name from HTTP, uses it in a command', async () => {
    trackVars('SV_USER_NAME');
    const result = await runTests(toYaml([
      {
        name: 'get-user',
        http: { url: baseUrl, method: 'GET', path: '/json' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_USER_NAME: { jsonPath: '$.user.name' } },
      },
      {
        name: 'echo-user',
        command: { command: 'echo "Hello $SV_USER_NAME"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Hello Alice' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Cross-type chaining: Command → HTTP ───────────────────────────────────────

describe('setVars integration – Command → HTTP chaining', () => {
  it('captures a key from command output, uses it in HTTP header', async () => {
    trackVars('SV_API_KEY');
    const result = await runTests(toYaml([
      {
        name: 'generate-key',
        command: { command: 'echo "my-secret-key"' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        setVars: { SV_API_KEY: { stdout: true } },
      },
      {
        name: 'use-key',
        http: {
          url: baseUrl,
          method: 'GET',
          path: '/check-key',
          headers: { 'X-Api-Key': '${SV_API_KEY}' },
        },
        source: { type: 'local' },
        expect: { statusCode: 200, bodyContains: 'authorized' },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Cross-type chaining: Command → Command ────────────────────────────────────

describe('setVars integration – Command → Command chaining', () => {
  it('captures jsonPath from command, uses it in next command', async () => {
    trackVars('SV_DB_PORT');
    const result = await runTests(toYaml([
      {
        name: 'read-config',
        command: { command: 'echo \'{"database": {"port": 5432}}\'', parseJson: true },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        setVars: { SV_DB_PORT: { jsonPath: '$.database.port' } },
      },
      {
        name: 'use-port',
        command: { command: 'echo "Connecting to port $SV_DB_PORT"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Connecting to port 5432' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── HTTP header capture → Command ─────────────────────────────────────────────

describe('setVars integration – HTTP header → Command', () => {
  it('captures response header and uses it in a command', async () => {
    trackVars('SV_REQ_ID');
    const result = await runTests(toYaml([
      {
        name: 'get-request-id',
        http: { url: baseUrl, method: 'GET', path: '/json' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_REQ_ID: { header: 'X-Request-Id' } },
      },
      {
        name: 'echo-request-id',
        command: { command: 'echo "Request ID: $SV_REQ_ID"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Request ID: req-42' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── HTTP statusCode capture → Command ─────────────────────────────────────────

describe('setVars integration – HTTP statusCode → Command', () => {
  it('captures status code and uses it in a command', async () => {
    trackVars('SV_STATUS_CODE');
    const result = await runTests(toYaml([
      {
        name: 'get-status',
        http: { url: baseUrl, method: 'GET', path: '/health' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_STATUS_CODE: { statusCode: true } },
      },
      {
        name: 'echo-status',
        command: { command: 'echo "Status: $SV_STATUS_CODE"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Status: 200' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── HTTP body capture → Command ───────────────────────────────────────────────

describe('setVars integration – HTTP body → Command', () => {
  it('captures full body and uses it in a command', async () => {
    trackVars('SV_FULL_BODY');
    const result = await runTests(toYaml([
      {
        name: 'get-body',
        http: { url: baseUrl, method: 'GET', path: '/health' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_FULL_BODY: { body: true } },
      },
      {
        name: 'echo-body',
        command: { command: 'echo "Body: $SV_FULL_BODY"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Body: healthy' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── HTTP regex capture → Command ──────────────────────────────────────────────

describe('setVars integration – HTTP regex → Command', () => {
  it('captures via regex and uses it in a command', async () => {
    trackVars('SV_CSRF_TOKEN');
    const result = await runTests(toYaml([
      {
        name: 'get-csrf',
        http: { url: baseUrl, method: 'GET', path: '/html' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { SV_CSRF_TOKEN: { regex: { pattern: 'value="([^"]+)"', group: 1 } } },
      },
      {
        name: 'echo-csrf',
        command: { command: 'echo "CSRF: $SV_CSRF_TOKEN"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'CSRF: csrf-abc-123' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Command regex (stdout) → HTTP ─────────────────────────────────────────────

describe('setVars integration – Command regex stdout → HTTP', () => {
  it('captures via regex from stdout and uses in HTTP header', async () => {
    trackVars('SV_EXTRACTED_KEY');
    const result = await runTests(toYaml([
      {
        name: 'extract-key',
        command: { command: 'echo "generated key=my-secret-key done"' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        setVars: { SV_EXTRACTED_KEY: { regex: { source: 'stdout', pattern: 'key=([^ ]+)', group: 1 } } },
      },
      {
        name: 'use-extracted-key',
        http: {
          url: baseUrl,
          method: 'GET',
          path: '/check-key',
          headers: { 'X-Api-Key': '${SV_EXTRACTED_KEY}' },
        },
        source: { type: 'local' },
        expect: { statusCode: 200, bodyContains: 'authorized' },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Command regex (stderr) → Command ──────────────────────────────────────────

describe('setVars integration – Command regex stderr → Command', () => {
  it('captures from stderr and uses in next command', async () => {
    trackVars('SV_STDERR_CODE');
    const result = await runTests(toYaml([
      {
        name: 'emit-warning',
        command: { command: 'echo "WARNING: error_code=77" >&2' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        setVars: { SV_STDERR_CODE: { regex: { source: 'stderr', pattern: 'error_code=(\\d+)', group: 1 } } },
      },
      {
        name: 'use-error-code',
        command: { command: 'echo "Error code was $SV_STDERR_CODE"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Error code was 77' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Command exitCode → Command ────────────────────────────────────────────────

describe('setVars integration – Command exitCode → Command', () => {
  it('captures exit code and uses it in next command', async () => {
    trackVars('SV_PREV_EXIT');
    const result = await runTests(toYaml([
      {
        name: 'run-with-exit',
        command: { command: 'exit 3' },
        source: { type: 'local' },
        expect: { exitCode: 3 },
        setVars: { SV_PREV_EXIT: { exitCode: true } },
      },
      {
        name: 'check-exit',
        command: { command: 'echo "Previous exit: $SV_PREV_EXIT"' },
        source: { type: 'local' },
        expect: { exitCode: 0, stdout: { contains: 'Previous exit: 3' } },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe('setVars integration – error cases', () => {
  it('throws when setVars is present without expect on HTTP test', async () => {
    await expect(
      executeTest(yaml({
        http: { url: baseUrl, method: 'GET', path: '/health' },
        source: { type: 'local' },
        setVars: { TOKEN: { body: true } },
      }))
    ).rejects.toThrow(/setVars requires "expect" to be defined/);
  });

  it('throws when setVars is present without expect on command test', async () => {
    await expect(
      executeTest(yaml({
        command: { command: 'echo hello' },
        source: { type: 'local' },
        setVars: { OUT: { stdout: true } },
      }))
    ).rejects.toThrow(/setVars requires "expect" to be defined/);
  });

  it('throws when jsonPath extraction fails', async () => {
    await expect(
      executeTest(yaml({
        http: { url: baseUrl, method: 'GET', path: '/json' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: { VAL: { jsonPath: '$.nonexistent.path' } },
      }))
    ).rejects.toThrow(/jsonPath.*returned no results/);
  });

  it('setVars does not run when expect fails', async () => {
    const key = 'SV_SHOULD_NOT_EXIST';
    delete process.env[key];
    await expect(
      executeTest(yaml({
        http: { url: baseUrl, method: 'GET', path: '/health' },
        source: { type: 'local' },
        expect: { statusCode: 404 }, // will fail — server returns 200
        setVars: { [key]: { body: true } },
      }))
    ).rejects.toThrow(/Status code mismatch/);
    expect(process.env[key]).toBeUndefined();
  });
});

// ── Multiple variables in one step ────────────────────────────────────────────

describe('setVars integration – multiple variables', () => {
  it('captures multiple values from one HTTP response and uses them all', async () => {
    trackVars('SV_M_TOKEN', 'SV_M_NAME', 'SV_M_STATUS', 'SV_M_REQ_ID');
    const result = await runTests(toYaml([
      {
        name: 'extract-all',
        http: { url: baseUrl, method: 'GET', path: '/json' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
        setVars: {
          SV_M_TOKEN: { jsonPath: '$.token' },
          SV_M_NAME: { jsonPath: '$.user.name' },
          SV_M_STATUS: { statusCode: true },
          SV_M_REQ_ID: { header: 'X-Request-Id' },
        },
      },
      {
        name: 'verify-all',
        command: { command: 'echo "$SV_M_TOKEN|$SV_M_NAME|$SV_M_STATUS|$SV_M_REQ_ID"' },
        source: { type: 'local' },
        expect: {
          exitCode: 0,
          stdout: { contains: 'secret-token-xyz|Alice|200|req-42' },
        },
      },
    ]));
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});
