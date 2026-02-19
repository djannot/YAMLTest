'use strict';

/**
 * Unit tests for the applySetVars function.
 *
 * Tests every extraction source for each test type (http, command, wait),
 * plus error cases and edge conditions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { applySetVars } from '../../src/index.js';

// Track env vars we set so we can clean them up
const createdVars = [];

function setAndTrack(setVars, data, testType) {
  for (const key of Object.keys(setVars)) {
    createdVars.push(key);
  }
  applySetVars(setVars, data, testType);
}

afterEach(() => {
  for (const key of createdVars) {
    delete process.env[key];
  }
  createdVars.length = 0;
});

// ── HTTP: jsonPath ────────────────────────────────────────────────────────────

describe('applySetVars – HTTP jsonPath', () => {
  it('extracts a value from JSON body via jsonPath', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: { user: { id: 42, name: 'Alice' } },
    };
    setAndTrack({ USER_ID: { jsonPath: '$.user.id' } }, data, 'http');
    expect(process.env.USER_ID).toBe('42');
  });

  it('extracts a string value from JSON body', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: { token: 'abc-123-xyz' },
    };
    setAndTrack({ TOKEN: { jsonPath: '$.token' } }, data, 'http');
    expect(process.env.TOKEN).toBe('abc-123-xyz');
  });

  it('parses string body as JSON for jsonPath extraction', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ status: 'ok' }),
    };
    setAndTrack({ STATUS: { jsonPath: '$.status' } }, data, 'http');
    expect(process.env.STATUS).toBe('ok');
  });

  it('extracts nested object and stringifies it', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: { config: { db: { host: 'localhost', port: 5432 } } },
    };
    setAndTrack({ DB_CONFIG: { jsonPath: '$.config.db' } }, data, 'http');
    expect(JSON.parse(process.env.DB_CONFIG)).toEqual({ host: 'localhost', port: 5432 });
  });

  it('throws when jsonPath returns no results', () => {
    const data = { statusCode: 200, headers: {}, body: { foo: 1 } };
    expect(() => setAndTrack({ VAL: { jsonPath: '$.missing' } }, data, 'http')).toThrow(
      /jsonPath "\$\.missing" returned no results/
    );
  });
});

// ── HTTP: header ──────────────────────────────────────────────────────────────

describe('applySetVars – HTTP header', () => {
  it('extracts a response header (case-insensitive)', () => {
    const data = {
      statusCode: 200,
      headers: { 'x-request-id': 'req-999', 'content-type': 'application/json' },
      body: '',
    };
    setAndTrack({ REQ_ID: { header: 'X-Request-Id' } }, data, 'http');
    expect(process.env.REQ_ID).toBe('req-999');
  });

  it('throws when header is not found', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ VAL: { header: 'X-Missing' } }, data, 'http')).toThrow(
      /extracted value is null or undefined/
    );
  });

  it('throws when used on a command test', () => {
    const data = { stdout: '', stderr: '', exitCode: 0 };
    expect(() => setAndTrack({ VAL: { header: 'X-Foo' } }, data, 'command')).toThrow(
      /"header" source is only valid for http tests/
    );
  });
});

// ── HTTP: statusCode ──────────────────────────────────────────────────────────

describe('applySetVars – HTTP statusCode', () => {
  it('captures the HTTP status code', () => {
    const data = { statusCode: 201, headers: {}, body: '' };
    setAndTrack({ CODE: { statusCode: true } }, data, 'http');
    expect(process.env.CODE).toBe('201');
  });

  it('throws when used on a command test', () => {
    const data = { stdout: '', stderr: '', exitCode: 0 };
    expect(() => setAndTrack({ CODE: { statusCode: true } }, data, 'command')).toThrow(
      /"statusCode" source is only valid for http tests/
    );
  });
});

// ── HTTP: body ────────────────────────────────────────────────────────────────

describe('applySetVars – HTTP body', () => {
  it('captures a string body', () => {
    const data = { statusCode: 200, headers: {}, body: 'healthy' };
    setAndTrack({ BODY: { body: true } }, data, 'http');
    expect(process.env.BODY).toBe('healthy');
  });

  it('captures a JSON body as stringified JSON', () => {
    const data = { statusCode: 200, headers: {}, body: { key: 'value' } };
    setAndTrack({ BODY: { body: true } }, data, 'http');
    expect(JSON.parse(process.env.BODY)).toEqual({ key: 'value' });
  });

  it('throws when used on a command test', () => {
    const data = { stdout: '', stderr: '', exitCode: 0 };
    expect(() => setAndTrack({ BODY: { body: true } }, data, 'command')).toThrow(
      /"body" source is only valid for http tests/
    );
  });
});

// ── HTTP: regex ───────────────────────────────────────────────────────────────

describe('applySetVars – HTTP regex', () => {
  it('extracts via regex capture group from body', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: 'token=abc-123&session=xyz',
    };
    setAndTrack(
      { TOKEN: { regex: { pattern: 'token=([^&]+)', group: 1 } } },
      data,
      'http'
    );
    expect(process.env.TOKEN).toBe('abc-123');
  });

  it('extracts from JSON-stringified body', () => {
    const data = {
      statusCode: 200,
      headers: {},
      body: { id: 42, name: 'Alice' },
    };
    setAndTrack(
      { USER_ID: { regex: { pattern: '"id":(\\d+)', group: 1 } } },
      data,
      'http'
    );
    expect(process.env.USER_ID).toBe('42');
  });

  it('defaults to capture group 1', () => {
    const data = { statusCode: 200, headers: {}, body: 'version: 3.2.1' };
    setAndTrack(
      { VER: { regex: { pattern: 'version: (\\S+)' } } },
      data,
      'http'
    );
    expect(process.env.VER).toBe('3.2.1');
  });

  it('throws when regex does not match', () => {
    const data = { statusCode: 200, headers: {}, body: 'no match here' };
    expect(() =>
      setAndTrack({ VAL: { regex: { pattern: 'missing-(\\d+)', group: 1 } } }, data, 'http')
    ).toThrow(/regex "missing-\(\\d\+\)" did not match/);
  });

  it('throws when capture group is out of bounds', () => {
    const data = { statusCode: 200, headers: {}, body: 'hello world' };
    expect(() =>
      setAndTrack({ VAL: { regex: { pattern: '(hello)', group: 5 } } }, data, 'http')
    ).toThrow(/regex capture group 5 not found/);
  });
});

// ── Command: stdout ───────────────────────────────────────────────────────────

describe('applySetVars – Command stdout', () => {
  it('captures full stdout', () => {
    const data = { stdout: 'hello world', stderr: '', exitCode: 0 };
    setAndTrack({ OUT: { stdout: true } }, data, 'command');
    expect(process.env.OUT).toBe('hello world');
  });

  it('throws when used on an http test', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ OUT: { stdout: true } }, data, 'http')).toThrow(
      /"stdout" source is only valid for command tests/
    );
  });
});

// ── Command: stderr ───────────────────────────────────────────────────────────

describe('applySetVars – Command stderr', () => {
  it('captures full stderr', () => {
    const data = { stdout: '', stderr: 'warning: something', exitCode: 0 };
    setAndTrack({ ERR: { stderr: true } }, data, 'command');
    expect(process.env.ERR).toBe('warning: something');
  });

  it('throws when used on an http test', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ ERR: { stderr: true } }, data, 'http')).toThrow(
      /"stderr" source is only valid for command tests/
    );
  });
});

// ── Command: exitCode ─────────────────────────────────────────────────────────

describe('applySetVars – Command exitCode', () => {
  it('captures exit code', () => {
    const data = { stdout: '', stderr: '', exitCode: 2 };
    setAndTrack({ EXIT: { exitCode: true } }, data, 'command');
    expect(process.env.EXIT).toBe('2');
  });

  it('captures zero exit code', () => {
    const data = { stdout: '', stderr: '', exitCode: 0 };
    setAndTrack({ EXIT: { exitCode: true } }, data, 'command');
    expect(process.env.EXIT).toBe('0');
  });

  it('throws when used on an http test', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ EXIT: { exitCode: true } }, data, 'http')).toThrow(
      /"exitCode" source is only valid for command tests/
    );
  });
});

// ── Command: jsonPath ─────────────────────────────────────────────────────────

describe('applySetVars – Command jsonPath', () => {
  it('extracts from parsed JSON in command output', () => {
    const data = {
      stdout: '{"version":"1.2.3"}',
      stderr: '',
      exitCode: 0,
      json: { version: '1.2.3' },
    };
    setAndTrack({ VER: { jsonPath: '$.version' } }, data, 'command');
    expect(process.env.VER).toBe('1.2.3');
  });

  it('throws when no json data available for command', () => {
    const data = { stdout: 'not json', stderr: '', exitCode: 0 };
    expect(() => setAndTrack({ VAL: { jsonPath: '$.key' } }, data, 'command')).toThrow(
      /no JSON data available/
    );
  });
});

// ── Command: regex ────────────────────────────────────────────────────────────

describe('applySetVars – Command regex', () => {
  it('extracts from stdout by default', () => {
    const data = { stdout: 'Process started with PID 12345', stderr: '', exitCode: 0 };
    setAndTrack(
      { PID: { regex: { pattern: 'PID (\\d+)', group: 1 } } },
      data,
      'command'
    );
    expect(process.env.PID).toBe('12345');
  });

  it('extracts from stdout with explicit source', () => {
    const data = { stdout: 'port=8080', stderr: '', exitCode: 0 };
    setAndTrack(
      { PORT: { regex: { source: 'stdout', pattern: 'port=(\\d+)', group: 1 } } },
      data,
      'command'
    );
    expect(process.env.PORT).toBe('8080');
  });

  it('extracts from stderr when source is stderr', () => {
    const data = { stdout: '', stderr: 'WARNING: code=42', exitCode: 0 };
    setAndTrack(
      { WARN_CODE: { regex: { source: 'stderr', pattern: 'code=(\\d+)', group: 1 } } },
      data,
      'command'
    );
    expect(process.env.WARN_CODE).toBe('42');
  });

  it('throws for invalid regex source', () => {
    const data = { stdout: 'hello', stderr: '', exitCode: 0 };
    expect(() =>
      setAndTrack({ VAL: { regex: { source: 'body', pattern: '(.*)', group: 1 } } }, data, 'command')
    ).toThrow(/regex source must be "stdout" or "stderr"/);
  });

  it('throws when regex is used on wait test', () => {
    const data = { extractedValue: 'hello' };
    expect(() =>
      setAndTrack({ VAL: { regex: { pattern: '(.*)', group: 1 } } }, data, 'wait')
    ).toThrow(/"regex" source is not valid for wait tests/);
  });
});

// ── Wait: value ───────────────────────────────────────────────────────────────

describe('applySetVars – Wait value', () => {
  it('captures the extracted jsonPath value from wait', () => {
    const data = { extractedValue: 3 };
    setAndTrack({ REPLICAS: { value: true } }, data, 'wait');
    expect(process.env.REPLICAS).toBe('3');
  });

  it('captures a string extracted value', () => {
    const data = { extractedValue: 'Running' };
    setAndTrack({ STATUS: { value: true } }, data, 'wait');
    expect(process.env.STATUS).toBe('Running');
  });

  it('throws when used on http test', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ VAL: { value: true } }, data, 'http')).toThrow(
      /"value" source is only valid for wait tests/
    );
  });

  it('throws when used on command test', () => {
    const data = { stdout: '', stderr: '', exitCode: 0 };
    expect(() => setAndTrack({ VAL: { value: true } }, data, 'command')).toThrow(
      /"value" source is only valid for wait tests/
    );
  });
});

// ── General error cases ───────────────────────────────────────────────────────

describe('applySetVars – error cases', () => {
  it('throws for unknown extraction rule', () => {
    const data = { statusCode: 200, headers: {}, body: '' };
    expect(() => setAndTrack({ VAL: { unknown: true } }, data, 'http')).toThrow(
      /unknown extraction rule/
    );
  });

  it('is a no-op when setVars is null', () => {
    expect(() => applySetVars(null, {}, 'http')).not.toThrow();
  });

  it('is a no-op when setVars is undefined', () => {
    expect(() => applySetVars(undefined, {}, 'http')).not.toThrow();
  });

  it('handles multiple variables in one setVars block', () => {
    const data = {
      statusCode: 200,
      headers: { 'x-server': 'nginx' },
      body: { token: 'secret', user: 'admin' },
    };
    createdVars.push('MULTI_TOKEN', 'MULTI_SERVER', 'MULTI_CODE');
    applySetVars(
      {
        MULTI_TOKEN: { jsonPath: '$.token' },
        MULTI_SERVER: { header: 'x-server' },
        MULTI_CODE: { statusCode: true },
      },
      data,
      'http'
    );
    expect(process.env.MULTI_TOKEN).toBe('secret');
    expect(process.env.MULTI_SERVER).toBe('nginx');
    expect(process.env.MULTI_CODE).toBe('200');
  });

  it('trims whitespace from string values', () => {
    const data = { stdout: '  hello world  ', stderr: '', exitCode: 0 };
    setAndTrack({ OUT: { stdout: true } }, data, 'command');
    expect(process.env.OUT).toBe('hello world');
  });

  it('throws when jsonPath is used on wait test', () => {
    const data = { extractedValue: 'test' };
    expect(() => setAndTrack({ VAL: { jsonPath: '$.key' } }, data, 'wait')).toThrow(
      /"jsonPath" source is not valid for wait tests/
    );
  });
});
