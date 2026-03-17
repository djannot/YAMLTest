'use strict';

import { describe, it, expect } from 'vitest';
import { validateTestDefinitions } from '../../src/validate.js';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// ── Helper ───────────────────────────────────────────────────────────

function expectValid(definitions) {
  expect(() => validateTestDefinitions(definitions)).not.toThrow();
}

function expectInvalid(definitions, messagePart) {
  let threw = false;
  try {
    validateTestDefinitions(definitions);
  } catch (err) {
    threw = true;
    expect(err.message).toMatch(/Validation failed/);
    if (messagePart) {
      expect(err.message).toContain(messagePart);
    }
  }
  expect(threw).toBe(true);
}

// Minimal valid definitions for each test type
const minimalHttp = {
  source: { type: 'local' },
  http: { url: 'http://example.com' },
  expect: { statusCode: 200 },
};

const minimalCommand = {
  source: { type: 'local' },
  command: { command: 'echo hello' },
  expect: { exitCode: 0 },
};

const minimalWait = {
  wait: {
    target: {
      kind: 'Deployment',
      metadata: { name: 'my-deploy' },
    },
  },
};

const minimalBodyComparison = {
  httpBodyComparison: {
    request1: {
      http: { url: 'http://a.com' },
      source: { type: 'local' },
    },
    request2: {
      http: { url: 'http://b.com' },
      source: { type: 'local' },
    },
  },
};

// ── Valid inputs ─────────────────────────────────────────────────────

describe('validateTestDefinitions – valid inputs', () => {
  it('accepts minimal HTTP test', () => {
    expectValid([minimalHttp]);
  });

  it('accepts minimal command test', () => {
    expectValid([minimalCommand]);
  });

  it('accepts minimal wait test', () => {
    expectValid([minimalWait]);
  });

  it('accepts minimal httpBodyComparison test', () => {
    expectValid([minimalBodyComparison]);
  });

  it('accepts multiple valid tests', () => {
    expectValid([minimalHttp, minimalCommand, minimalWait, minimalBodyComparison]);
  });

  it('accepts HTTP test with all optional fields', () => {
    expectValid([{
      name: 'full-http',
      retries: 3,
      source: { type: 'local' },
      http: {
        url: 'https://api.example.com',
        method: 'POST',
        path: '/v1/data',
        headers: { Authorization: 'Bearer tok' },
        params: { page: '1' },
        body: { key: 'value' },
        skipSslVerification: true,
        maxRedirects: 5,
        cert: '/path/cert.pem',
        key: '/path/key.pem',
        ca: '/path/ca.pem',
        scheme: 'https',
        port: 443,
      },
      expect: {
        statusCode: [200, 201],
        body: { ok: true },
        bodyContains: 'ok',
        bodyRegex: 'ok|success',
        bodyJsonPath: [{ path: '$.ok', comparator: 'equals', value: true }],
        headers: [{ name: 'content-type', comparator: 'contains', value: 'json' }],
      },
      setVars: {
        TOKEN: { jsonPath: '$.token' },
        REQ_ID: { header: 'x-request-id' },
        STATUS: { statusCode: true },
        BODY: { body: true },
        CSRF: { regex: { pattern: 'csrf=([a-z]+)', group: 1 } },
      },
    }]);
  });

  it('accepts command test with all optional fields', () => {
    expectValid([{
      name: 'full-command',
      retries: 1,
      source: { type: 'local' },
      command: {
        command: 'echo hello',
        parseJson: true,
        env: { FOO: 'bar' },
        workingDir: '/tmp',
      },
      expect: {
        exitCode: 0,
        stdout: { contains: 'hello' },
        stderr: { equals: '' },
        output: { matches: 'hello' },
        json: { greeting: 'hello' },
        jsonPath: [{ path: '$.greeting', comparator: 'equals', value: 'hello' }],
      },
      setVars: {
        OUT: { stdout: true },
        ERR: { stderr: true },
        CODE: { exitCode: true },
        JP: { jsonPath: '$.greeting' },
        PID: { regex: { pattern: '(\\d+)', group: 1, source: 'stdout' } },
      },
    }]);
  });

  it('accepts wait test with all optional fields and setVars', () => {
    expectValid([{
      name: 'full-wait',
      source: { type: 'local' },
      wait: {
        target: {
          kind: 'Deployment',
          context: 'my-cluster',
          metadata: { namespace: 'default', name: 'my-deploy' },
        },
        jsonPath: '$.status.readyReplicas',
        jsonPathExpectation: { comparator: 'greaterThan', value: 0, negate: false },
        polling: { timeoutSeconds: 120, intervalSeconds: 5, maxRetries: 24 },
      },
      setVars: { READY: { value: true } },
    }]);
  });

  it('accepts httpBodyComparison with all optional fields', () => {
    expectValid([{
      name: 'full-comparison',
      source: { type: 'local' },
      httpBodyComparison: {
        request1: {
          http: { url: 'http://v1.com', method: 'GET', path: '/' },
          source: { type: 'local' },
        },
        request2: {
          http: { url: 'http://v2.com', method: 'GET', path: '/' },
          source: { type: 'local' },
        },
        parseAsJson: true,
        delaySeconds: 2,
        removeJsonPaths: ['$.timestamp', '$.id'],
      },
    }]);
  });

  it('accepts pod source with selector (name)', () => {
    expectValid([{
      source: {
        type: 'pod',
        selector: { kind: 'Pod', metadata: { namespace: 'default', name: 'my-pod' } },
        container: 'app',
        usePortForward: true,
        usePodExec: false,
      },
      http: { url: 'http://localhost', method: 'GET', path: '/health' },
      expect: { statusCode: 200 },
    }]);
  });

  it('accepts pod source with selector (labels)', () => {
    expectValid([{
      source: {
        type: 'pod',
        selector: { kind: 'Pod', metadata: { labels: { app: 'web' } } },
      },
      http: { url: 'http://localhost' },
      expect: { statusCode: 200 },
    }]);
  });

  it('accepts HTTP method in lowercase', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://example.com', method: 'post' },
      expect: { statusCode: 201 },
    }]);
  });

  it('accepts bodyContains as array of mixed strings and objects', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://example.com' },
      expect: {
        statusCode: 200,
        bodyContains: [
          'hello',
          { value: 'world', negate: false, matchword: true },
        ],
      },
    }]);
  });

  it('accepts command stdout as string shorthand', () => {
    expectValid([{
      source: { type: 'local' },
      command: { command: 'echo hi' },
      expect: { exitCode: 0, stdout: 'hi' },
    }]);
  });
});

// ── k8s selector apiVersion ──────────────────────────────────────────

describe('validateTestDefinitions – k8s selector apiVersion', () => {
  it('accepts wait target with apiVersion (group/version)', () => {
    expectValid([{
      wait: {
        target: {
          kind: 'Deployment',
          apiVersion: 'apps/v1',
          metadata: { name: 'my-deploy' },
        },
      },
    }]);
  });

  it('accepts wait target with core apiVersion (v1)', () => {
    expectValid([{
      wait: {
        target: {
          kind: 'Pod',
          apiVersion: 'v1',
          metadata: { name: 'my-pod' },
        },
      },
    }]);
  });

  it('accepts pod source selector with apiVersion', () => {
    expectValid([{
      source: {
        type: 'pod',
        selector: {
          kind: 'Pod',
          apiVersion: 'v1',
          metadata: { name: 'my-pod' },
        },
      },
      http: { url: 'http://localhost' },
      expect: { statusCode: 200 },
    }]);
  });

  it('accepts wait target without apiVersion (still optional)', () => {
    expectValid([minimalWait]);
  });

  it('rejects apiVersion as a non-string', () => {
    expectInvalid([{
      wait: {
        target: {
          kind: 'Deployment',
          apiVersion: 123,
          metadata: { name: 'my-deploy' },
        },
      },
    }], 'apiVersion');
  });
});

// ── Test type mutual exclusivity ─────────────────────────────────────

describe('validateTestDefinitions – mutual exclusivity', () => {
  it('rejects test with no test type', () => {
    expectInvalid([{ source: { type: 'local' } }]);
  });

  it('rejects test with both http and command', () => {
    expectInvalid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      command: { command: 'echo' },
    }]);
  });

  it('rejects test with both http and wait', () => {
    expectInvalid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      wait: { target: { kind: 'Pod', metadata: { name: 'x' } } },
    }]);
  });

  it('rejects test with all four types', () => {
    expectInvalid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      command: { command: 'echo' },
      wait: { target: { kind: 'Pod', metadata: { name: 'x' } } },
      httpBodyComparison: {
        request1: { http: { url: 'http://a' }, source: { type: 'local' } },
        request2: { http: { url: 'http://b' }, source: { type: 'local' } },
      },
    }]);
  });
});

// ── Required fields ──────────────────────────────────────────────────

describe('validateTestDefinitions – required fields', () => {
  it('rejects http test missing source', () => {
    expectInvalid(
      [{ http: { url: 'http://x.com' }, expect: { statusCode: 200 } }],
      'source',
    );
  });

  it('rejects command test missing source', () => {
    expectInvalid(
      [{ command: { command: 'echo hi' }, expect: { exitCode: 0 } }],
      'source',
    );
  });

  it('accepts wait test without source', () => {
    expectValid([minimalWait]);
  });

  it('accepts httpBodyComparison test without source', () => {
    expectValid([minimalBodyComparison]);
  });

  it('rejects source missing type', () => {
    expectInvalid(
      [{ source: {}, http: { url: 'http://x.com' } }],
      'type',
    );
  });

  it('rejects command object missing command property', () => {
    expectInvalid(
      [{ source: { type: 'local' }, command: { parseJson: true }, expect: { exitCode: 0 } }],
      'command',
    );
  });

  it('rejects wait missing target', () => {
    expectInvalid(
      [{ wait: { jsonPath: '$.x' } }],
      'target',
    );
  });

  it('rejects httpBodyComparison missing request2', () => {
    expectInvalid(
      [{
        httpBodyComparison: {
          request1: { http: { url: 'http://a' }, source: { type: 'local' } },
        },
      }],
      'request2',
    );
  });

  it('rejects k8s selector missing metadata', () => {
    expectInvalid(
      [{
        source: { type: 'pod', selector: { kind: 'Pod' } },
        http: { url: 'http://x' },
        expect: { statusCode: 200 },
      }],
      'metadata',
    );
  });

  it('rejects k8s metadata missing both name and labels', () => {
    expectInvalid(
      [{
        source: { type: 'pod', selector: { kind: 'Pod', metadata: { namespace: 'default' } } },
        http: { url: 'http://x' },
        expect: { statusCode: 200 },
      }],
    );
  });
});

// ── Type validation ──────────────────────────────────────────────────

describe('validateTestDefinitions – type errors', () => {
  it('rejects retries as string', () => {
    expectInvalid(
      [{ ...minimalHttp, retries: 'three' }],
      'integer',
    );
  });

  it('rejects negative retries', () => {
    expectInvalid(
      [{ ...minimalHttp, retries: -1 }],
    );
  });

  it('rejects invalid HTTP method', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        http: { url: 'http://x.com', method: 'FOOBAR' },
        expect: { statusCode: 200 },
      }],
    );
  });

  it('rejects invalid source type', () => {
    expectInvalid(
      [{ source: { type: 'docker' }, http: { url: 'http://x.com' } }],
    );
  });

  it('rejects invalid comparator', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        http: { url: 'http://x.com' },
        expect: {
          bodyJsonPath: [{ path: '$.x', comparator: 'startsWith', value: 'y' }],
        },
      }],
    );
  });

  it('rejects invalid header comparator', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        http: { url: 'http://x.com' },
        expect: {
          headers: [{ name: 'x', comparator: 'startsWith', value: '1' }],
        },
      }],
    );
  });

  it('accepts greaterThan/lessThan header comparators', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      expect: {
        headers: [
          { name: 'x-time', comparator: 'greaterThan', value: 100 },
          { name: 'x-time', comparator: 'lessThan', value: 5000 },
        ],
      },
    }]);
  });
});

// ── Conditional requirements ─────────────────────────────────────────

describe('validateTestDefinitions – conditional requirements', () => {
  it('rejects pod source without selector', () => {
    expectInvalid(
      [{ source: { type: 'pod' }, http: { url: 'http://x' }, expect: { statusCode: 200 } }],
      'selector',
    );
  });

  it('rejects setVars without expect for HTTP', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        http: { url: 'http://x' },
        setVars: { TOKEN: { jsonPath: '$.token' } },
      }],
      'expect',
    );
  });

  it('rejects setVars without expect for command', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        command: { command: 'echo' },
        setVars: { OUT: { stdout: true } },
      }],
      'expect',
    );
  });

  it('rejects expect on wait test', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        wait: { target: { kind: 'Pod', metadata: { name: 'x' } } },
        expect: { statusCode: 200 },
      }],
    );
  });

  it('rejects expect on httpBodyComparison test', () => {
    expectInvalid(
      [{
        ...minimalBodyComparison,
        expect: { statusCode: 200 },
      }],
    );
  });

  it('rejects setVars on httpBodyComparison test', () => {
    expectInvalid(
      [{
        ...minimalBodyComparison,
        setVars: { X: { body: true } },
      }],
    );
  });

  it('allows setVars without expect for wait test', () => {
    expectValid([{
      source: { type: 'local' },
      wait: {
        target: { kind: 'Deployment', metadata: { name: 'x' } },
        jsonPath: '$.status.readyReplicas',
      },
      setVars: { COUNT: { value: true } },
    }]);
  });
});

// ── Additional properties (typo detection) ───────────────────────────

describe('validateTestDefinitions – unknown properties', () => {
  it('rejects unknown property in http config', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        http: { url: 'http://x.com', timeout: 5000 },
        expect: { statusCode: 200 },
      }],
      'timeout',
    );
  });

  it('rejects unknown property in command config', () => {
    expectInvalid(
      [{
        source: { type: 'local' },
        command: { command: 'echo', shell: 'bash' },
        expect: { exitCode: 0 },
      }],
      'shell',
    );
  });

  it('rejects unknown property in source', () => {
    expectInvalid(
      [{
        source: { type: 'local', namespace: 'default' },
        http: { url: 'http://x.com' },
        expect: { statusCode: 200 },
      }],
      'namespace',
    );
  });

  it('allows additional properties at test definition level', () => {
    validateTestDefinitions([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      expect: { statusCode: 200 },
      test_title: 'my custom title',
      timeout: 5000,
    }]);
  });
});

// ── Error message quality ────────────────────────────────────────────

describe('validateTestDefinitions – error messages', () => {
  it('includes test index in error', () => {
    try {
      validateTestDefinitions([
        minimalHttp,
        { source: { type: 'local' } }, // invalid: no test type
      ]);
      expect.fail('should throw');
    } catch (err) {
      expect(err.message).toContain('Test #2');
    }
  });

  it('includes test name in error when provided', () => {
    try {
      validateTestDefinitions([
        { name: 'my-test', source: { type: 'local' } }, // invalid
      ]);
      expect.fail('should throw');
    } catch (err) {
      expect(err.message).toContain('my-test');
    }
  });

  it('includes "Validation failed" prefix', () => {
    expectInvalid([{ source: { type: 'local' } }], 'Validation failed');
  });
});

// ── Empty/edge cases ─────────────────────────────────────────────────

describe('validateTestDefinitions – edge cases', () => {
  it('rejects empty array', () => {
    expectInvalid([], 'Validation failed');
  });

  it('accepts HTTP test without expect (no setVars)', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
    }]);
  });

  it('accepts command test without expect (no setVars)', () => {
    expectValid([{
      source: { type: 'local' },
      command: { command: 'echo hello' },
    }]);
  });

  it('accepts empty expect object for HTTP', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://x.com' },
      expect: {},
    }]);
  });

  it('accepts http port as string', () => {
    expectValid([{
      source: { type: 'local' },
      http: { url: 'http://x.com', port: 'http' },
      expect: { statusCode: 200 },
    }]);
  });
});

// ── Schema completeness guard ────────────────────────────────────────

describe('validateTestDefinitions – completeness guard', () => {
  it('validates the complete fixture file (all fields across all types)', () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/valid-complete.yaml');
    const content = fs.readFileSync(fixturePath, 'utf8');
    const definitions = yaml.load(content);
    expectValid(definitions);
  });
});
