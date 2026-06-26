'use strict';

/**
 * Unit tests for src/runner.js
 *
 * Tests parseTestDefinitions, the fail-fast orchestration, and retry logic.
 * Uses real local shell commands (fast, no network, no mock complexity).
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { runTests, parseTestDefinitions, parseDuration } from '../../src/runner.js';

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

  it('does not retry when retries is 0', async () => {
    const yaml = JSON.stringify([
      {
        name: 'no-retry',
        command: { command: 'false' },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        retries: 0,
      },
    ]);
    const result = await runTests(yaml);
    expect(result.results[0].attempts).toBe(1);
  });

  it('honours the YAMLTEST_RETRIES env default when a test omits retries', async () => {
    const prev = process.env.YAMLTEST_RETRIES;
    process.env.YAMLTEST_RETRIES = '2'; // override the suite's pinned 0
    try {
      const result = await runTests(JSON.stringify([
        { name: 'env-default', command: { command: 'false' }, source: { type: 'local' }, expect: { exitCode: 0 } },
      ]));
      expect(result.results[0].attempts).toBe(3); // 1 + 2 env-default retries
    } finally {
      process.env.YAMLTEST_RETRIES = prev;
    }
  });
});

// ── parseDuration ─────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('passes through plain numbers as milliseconds', () => {
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration(0)).toBe(0);
  });
  it('parses duration strings with units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30000);
    expect(parseDuration('3m')).toBe(180000);
    expect(parseDuration('1h')).toBe(3600000);
  });
  it('treats a unitless string as milliseconds', () => {
    expect(parseDuration('250')).toBe(250);
  });
  it('returns null for absent or unparseable values', () => {
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration('soon')).toBeNull();
  });
});

// ── consecutive ───────────────────────────────────────────────────────────────

describe('runTests – consecutive', () => {
  afterEach(() => { /* temp files are unique per test */ });

  it('runs the test `consecutive` times in a single passing attempt', async () => {
    const counter = path.join(os.tmpdir(), `yt-consec-pass-${process.pid}-${Date.now()}`);
    if (fs.existsSync(counter)) fs.unlinkSync(counter);
    const result = await runTests(JSON.stringify([
      {
        name: 'consec-pass',
        command: { command: `echo x >> ${counter}` },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        consecutive: 3,
        retries: 0,
      },
    ]));
    expect(result.passed).toBe(1);
    const runs = fs.readFileSync(counter, 'utf8').trim().split('\n').length;
    expect(runs).toBe(3); // executeTest invoked 3 times in the one attempt
    fs.unlinkSync(counter);
  });

  it('fails the attempt and short-circuits when a consecutive run fails', async () => {
    const counter = path.join(os.tmpdir(), `yt-consec-fail-${process.pid}-${Date.now()}`);
    if (fs.existsSync(counter)) fs.unlinkSync(counter);
    const result = await runTests(JSON.stringify([
      {
        name: 'consec-fail',
        command: { command: `echo x >> ${counter}; false` },
        source: { type: 'local' },
        expect: { exitCode: 0 },
        consecutive: 3,
        retries: 0,
      },
    ]));
    expect(result.failed).toBe(1);
    const runs = fs.readFileSync(counter, 'utf8').trim().split('\n').length;
    expect(runs).toBe(1); // stopped at the first failing run, did not continue the group
    fs.unlinkSync(counter);
  });
});

// ── maxtime budget ──────────────────────────────────────────────────────────

describe('runTests – maxtime budget', () => {
  it('stops retrying once the maxtime budget is exceeded', async () => {
    const prev = process.env.YAMLTEST_RETRY_INTERVAL_MS;
    process.env.YAMLTEST_RETRY_INTERVAL_MS = '40';
    try {
      const start = Date.now();
      const result = await runTests(JSON.stringify([
        {
          name: 'budget',
          command: { command: 'false' },
          source: { type: 'local' },
          expect: { exitCode: 0 },
          retries: 1000,     // would run a long time without a budget
          maxtime: '200ms',  // ← circuit-breaker
        },
      ]));
      expect(result.failed).toBe(1);
      expect(result.results[0].timedOut).toBe(true);
      expect(result.results[0].attempts).toBeLessThan(1001);
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      process.env.YAMLTEST_RETRY_INTERVAL_MS = prev;
    }
  });
});
