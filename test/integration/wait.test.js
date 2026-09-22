'use strict';

/**
 * Integration tests for the wait test type (executeKubectlWait).
 *
 * These run without a cluster: a stub `kubectl` shell script is placed first on
 * PATH and prints a fixture document for any `get ... -o json` invocation. That
 * exercises the real polling / assertion / setVars pipeline
 * (executeTest → executeKubectlWait → JSONPath → compareValue) while keeping
 * the suite hermetic. Real-cluster coverage lives in test/e2e/kubectl.test.js.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest, executeKubectlWait } from '../../src/index.js';

// ── Fixture the stub kubectl returns ─────────────────────────────────────────

const FIXTURE = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'agentgateway-config', namespace: 'agentgateway-system' },
  data: {
    'token-exchange-validators.yaml':
      'subjectValidators:\n  - a\nactorValidators:\n  - b\napiValidators:\n  - c\n',
    'empty.yaml': '',
  },
  spec: {
    replicas: 3,
    template: {
      spec: {
        containers: [
          { env: [{ name: 'LOG_LEVEL', value: 'debug' }, { name: 'MODE', value: 'strict' }] },
        ],
      },
    },
  },
  status: { readyReplicas: 3, phase: 'Running' },
};

let tmpDir;
let originalPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-wait-'));
  const fixturePath = path.join(tmpDir, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE));

  const stub = path.join(tmpDir, 'kubectl');
  fs.writeFileSync(stub, `#!/bin/sh\ncat ${fixturePath}\n`);
  fs.chmodSync(stub, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function yaml(obj) {
  return JSON.stringify(obj);
}

const TARGET = {
  kind: 'ConfigMap',
  metadata: { namespace: 'agentgateway-system', name: 'agentgateway-config' },
};

/** Short polling so failing-path tests finish quickly. */
const FAST = { timeoutSeconds: 3, intervalSeconds: 1 };

function waitTest(waitConfig, extra = {}) {
  return yaml({ wait: { target: TARGET, polling: FAST, ...waitConfig }, ...extra });
}

// ── Array form ───────────────────────────────────────────────────────────────

describe('wait – array form of jsonPath', () => {
  it('passes when every entry matches', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [
        { path: "$.data['token-exchange-validators.yaml']", comparator: 'contains', value: 'subjectValidators:' },
        { path: "$.data['token-exchange-validators.yaml']", comparator: 'contains', value: 'actorValidators:' },
        { path: "$.data['token-exchange-validators.yaml']", comparator: 'contains', value: 'apiValidators:' },
      ],
    }))).resolves.toBe(true);
  });

  it('passes with a single entry', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [{ path: '$.status.phase', comparator: 'equals', value: 'Running' }],
    }))).resolves.toBe(true);
  });

  it('supports mixed comparators, negate and filter expressions in one attempt', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [
        { path: '$.spec.template.spec.containers[0].env[?(@.name=="LOG_LEVEL")].value', comparator: 'equals', value: 'debug' },
        { path: '$.spec.template.spec.containers[0].env[?(@.name=="MODE")].value', comparator: 'equals', value: 'strict' },
        { path: '$.spec.replicas', comparator: 'greaterThan', value: 0 },
        { path: '$.status.phase', comparator: 'exists' },
        { path: '$.status.phase', comparator: 'contains', value: 'Failed', negate: true },
        { path: "$.data['token-exchange-validators.yaml']", comparator: 'matches', value: 'apiValidators:' },
      ],
    }))).resolves.toBe(true);
  });

  it('fails after retries when one entry never matches, naming that path', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [
        { path: '$.spec.replicas', comparator: 'equals', value: 3 },
        { path: '$.status.phase', comparator: 'equals', value: 'Pending' },
      ],
    }))).rejects.toThrow(/Timed-out[\s\S]*\$\.status\.phase/);
  });

  it('fails after retries when one path is absent, naming that path', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [
        { path: '$.spec.replicas', comparator: 'equals', value: 3 },
        { path: '$.status.missingField', comparator: 'exists' },
      ],
    }))).rejects.toThrow(/Timed-out[\s\S]*\$\.status\.missingField/);
  });

  it('honours maxRetries in the array form', async () => {
    await expect(executeTest(waitTest({
      jsonPath: [{ path: '$.status.phase', comparator: 'equals', value: 'Terminating' }],
      polling: { timeoutSeconds: 60, intervalSeconds: 1, maxRetries: 2 },
    }))).rejects.toThrow(/[Mm]aximum retries/);
  });

  it('rejects setVars value extraction against the array form', async () => {
    await expect(executeTest(waitTest(
      { jsonPath: [{ path: '$.status.phase', comparator: 'exists' }] },
      { setVars: { WAIT_ARRAY_VAR: { value: true } } },
    ))).rejects.toThrow(/requires the string form/);
  });
});

// ── Runner-level setVars guard ───────────────────────────────────────────────
//
// executeTest validates against the schema first, so these call the runner
// directly to prove its own guard holds for embedders that bypass the schema.

describe('wait – executeKubectlWait setVars guard', () => {
  it('throws for the array form', async () => {
    await expect(executeKubectlWait(
      { target: TARGET, polling: FAST, jsonPath: [{ path: '$.status.phase', comparator: 'exists' }] },
      { SOME_VAR: { value: true } },
    )).rejects.toThrow(/requires the string form of "jsonPath"/);
  });

  it('throws when jsonPath is absent', async () => {
    await expect(executeKubectlWait(
      { target: TARGET, polling: FAST },
      { SOME_VAR: { value: true } },
    )).rejects.toThrow(/requires "jsonPath" to be defined/);
  });

  it('allows the string form', async () => {
    delete process.env.YAMLTEST_DIRECT_PHASE;
    await expect(executeKubectlWait(
      { target: TARGET, polling: FAST, jsonPath: '$.status.phase' },
      { YAMLTEST_DIRECT_PHASE: { value: true } },
    )).resolves.toBe(true);
    expect(process.env.YAMLTEST_DIRECT_PHASE).toBe('Running');
    delete process.env.YAMLTEST_DIRECT_PHASE;
  });
});

// ── String form (regression) ─────────────────────────────────────────────────

describe('wait – string form of jsonPath (regression)', () => {
  it('passes with jsonPathExpectation', async () => {
    await expect(executeTest(waitTest({
      jsonPath: '$.status.readyReplicas',
      jsonPathExpectation: { comparator: 'greaterThan', value: 0 },
    }))).resolves.toBe(true);
  });

  it('fails when the expectation is never met', async () => {
    await expect(executeTest(waitTest({
      jsonPath: '$.status.readyReplicas',
      jsonPathExpectation: { comparator: 'greaterThan', value: 99 },
    }))).rejects.toThrow(/Timed-out[\s\S]*\$\.status\.readyReplicas to greaterThan 99/);
  });

  it('passes with no expectation when the value is present and non-empty', async () => {
    await expect(executeTest(waitTest({ jsonPath: '$.status.phase' }))).resolves.toBe(true);
  });

  it('retries to timeout when the value is an empty string', async () => {
    await expect(executeTest(waitTest({ jsonPath: "$.data['empty.yaml']" })))
      .rejects.toThrow(/Timed-out/);
  });

  it('passes with no jsonPath at all (existence only)', async () => {
    await expect(executeTest(waitTest({}))).resolves.toBe(true);
  });

  it('accepts a jq-style path without the leading $', async () => {
    await expect(executeTest(waitTest({
      jsonPath: '.status.phase',
      jsonPathExpectation: { comparator: 'equals', value: 'Running' },
    }))).resolves.toBe(true);
  });

  it('captures the extracted value via setVars', async () => {
    delete process.env.YAMLTEST_WAIT_REPLICAS;
    await executeTest(waitTest(
      { jsonPath: '$.status.readyReplicas' },
      { setVars: { YAMLTEST_WAIT_REPLICAS: { value: true } } },
    ));
    expect(process.env.YAMLTEST_WAIT_REPLICAS).toBe('3');
    delete process.env.YAMLTEST_WAIT_REPLICAS;
  });

  it('rejects setVars value extraction when jsonPath is absent', async () => {
    await expect(executeTest(waitTest({}, { setVars: { NO_PATH: { value: true } } })))
      .rejects.toThrow(/requires "jsonPath" to be defined/);
  });
});
