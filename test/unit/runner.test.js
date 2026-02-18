'use strict';

/**
 * Unit tests for src/runner.js
 *
 * Tests parseTestDefinitions, the fail-fast orchestration, and retry logic.
 * Uses real local shell commands (fast, no network, no mock complexity).
 */

import { describe, it, expect } from 'vitest';
import { runTests, parseTestDefinitions } from '../../src/runner.js';

// ── parseTestDefinitions ──────────────────────────────────────────────────────

describe('parseTestDefinitions', () => {
  it('parses a single object into a one-element array', () => {
    const yaml = '{ name: single-test, http: { url: "http://x" } }';
    const defs = parseTestDefinitions(yaml);
    expect(Array.isArray(defs)).toBe(true);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('single-test');
  });

  it('parses a YAML array of test objects', () => {
    const yaml = '- name: test-1\n- name: test-2\n- name: test-3';
    const defs = parseTestDefinitions(yaml);
    expect(defs).toHaveLength(3);
    expect(defs[2].name).toBe('test-3');
  });

  it('throws on invalid YAML', () => {
    expect(() => parseTestDefinitions('{ unclosed: [')).toThrow(/Failed to parse YAML/);
  });

  it('throws on empty input', () => {
    expect(() => parseTestDefinitions('')).toThrow();
  });

  it('throws on YAML that is a primitive', () => {
    expect(() => parseTestDefinitions('42')).toThrow(/Invalid YAML/);
  });
});

// ── runTests – happy path ─────────────────────────────────────────────────────

const passCmd = (name) => JSON.stringify({
  name,
  command: { command: 'true' },
  source: { type: 'local' },
  expect: { exitCode: 0 },
});

const failCmd = (name) => JSON.stringify({
  name,
  command: { command: 'false' },
  source: { type: 'local' },
  expect: { exitCode: 0 }, // false exits 1, so this will fail
});

describe('runTests – all pass', () => {
  it('returns passed=total when all tests succeed', async () => {
    const yaml = JSON.stringify([
      { name: 't1', command: { command: 'echo hi' }, source: { type: 'local' }, expect: { exitCode: 0 } },
      { name: 't2', command: { command: 'echo hi' }, source: { type: 'local' }, expect: { exitCode: 0 } },
    ]);
    const result = await runTests(yaml);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('records test names correctly', async () => {
    const yaml = JSON.stringify([
      { name: 'my-named-test', command: { command: 'true' }, source: { type: 'local' }, expect: { exitCode: 0 } },
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].name).toBe('my-named-test');
  });

  it('records duration >= 0', async () => {
    const yaml = JSON.stringify([
      { name: 't', command: { command: 'true' }, source: { type: 'local' }, expect: { exitCode: 0 } },
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts a single test object (not wrapped in array)', async () => {
    const yaml = JSON.stringify({
      name: 'single',
      command: { command: 'true' },
      source: { type: 'local' },
      expect: { exitCode: 0 },
    });
    const result = await runTests(yaml);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
  });
});

// ── runTests – fail-fast ──────────────────────────────────────────────────────

describe('runTests – fail-fast', () => {
  it('stops after first failure and marks rest as skipped', async () => {
    const yaml = JSON.stringify([
      { name: 't1', command: { command: 'true' }, source: { type: 'local' }, expect: { exitCode: 0 } },
      { name: 't2', command: { command: 'false' }, source: { type: 'local' }, expect: { exitCode: 0 } },
      { name: 't3', command: { command: 'true' }, source: { type: 'local' }, expect: { exitCode: 0 } },
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

  it('records an error message on failure', async () => {
    const yaml = JSON.stringify([
      { name: 'fail', command: { command: 'false' }, source: { type: 'local' }, expect: { exitCode: 0 } },
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].error).toMatch(/Exit code mismatch/);
  });
});

// ── runTests – retry ──────────────────────────────────────────────────────────

describe('runTests – retry', () => {
  it('succeeds after retries when the command passes on first try (retries: 2 is a no-op for passing tests)', async () => {
    const yaml = JSON.stringify([
      {
        name: 'always-pass',
        command: { command: 'true' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        retries: 2,
      },
    ]);
    const result = await runTests(yaml);
    expect(result.passed).toBe(1);
    expect(result.results[0].attempts).toBe(1); // passed on first attempt
  });

  it('fails and reports all retries used on a command that always fails', async () => {
    const yaml = JSON.stringify([
      {
        name: 'always-fail',
        command: { command: 'false' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        retries: 2,
      },
    ]);
    const result = await runTests(yaml);
    expect(result.failed).toBe(1);
    expect(result.results[0].attempts).toBe(3); // 1 + 2 retries
  });

  it('does not retry when retries is 0 (default)', async () => {
    const yaml = JSON.stringify([
      {
        name: 'no-retry',
        command: { command: 'false' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
      },
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].attempts).toBe(1);
  });
});
