'use strict';

/**
 * Integration tests for command test execution.
 *
 * Runs real local shell commands so the entire command pipeline is exercised:
 * executeTest → executeCommandTest → executeLocalCommand → child_process.spawn
 */

import { describe, it, expect } from 'vitest';
import { executeTest } from '../../src/index.js';

function yaml(obj) {
  return JSON.stringify(obj);
}

describe('Command integration – exit codes', () => {
  it('passes when command exits 0', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'true' },
          source: { type: 'local' },
          expect: { exitCode: 0 },
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when command exits non-zero unexpectedly', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'false' },
          source: { type: 'local' },
          expect: { exitCode: 0 },
        })
      )
    ).rejects.toThrow(/Exit code mismatch/);
  });

  it('passes when expected exit code is non-zero', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'exit 2' },
          source: { type: 'local' },
          expect: { exitCode: 2 },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('Command integration – stdout validation', () => {
  it('validates stdout contains string', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo "Hello, World!"' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'Hello' } },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates stdout exact equality', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'printf "exact"' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { equals: 'exact' } },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates stdout regex', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo "2024-01-15"' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { matches: '\\d{4}-\\d{2}-\\d{2}' } },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates stdout does not contain (negate)', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo "everything is ok"' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'error', negate: true } },
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when negated substring is present', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo "fatal error occurred"' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'error', negate: true } },
        })
      )
    ).rejects.toThrow();
  });
});

describe('Command integration – JSON output', () => {
  it('parses JSON output and validates via jsonPath', async () => {
    const payload = JSON.stringify({ version: '2.0.0', ready: true });
    await expect(
      executeTest(
        yaml({
          command: { command: `echo '${payload}'`, parseJson: true },
          source: { type: 'local' },
          expect: {
            exitCode: 0,
            jsonPath: [{ path: '$.version', comparator: 'equals', value: '2.0.0' }],
          },
        })
      )
    ).resolves.toBe(true);
  });

  it('validates multiple JSON path assertions', async () => {
    const payload = JSON.stringify({ a: 1, b: 'hello', c: [1, 2, 3] });
    await expect(
      executeTest(
        yaml({
          command: { command: `echo '${payload}'`, parseJson: true },
          source: { type: 'local' },
          expect: {
            exitCode: 0,
            jsonPath: [
              { path: '$.a', comparator: 'equals', value: 1 },
              { path: '$.b', comparator: 'contains', value: 'ell' },
            ],
          },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('Command integration – environment variables', () => {
  it('passes custom env vars to the command', async () => {
    await expect(
      executeTest(
        yaml({
          command: {
            command: 'echo $MY_TEST_VAR',
            env: { MY_TEST_VAR: 'injected-value' },
          },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'injected-value' } },
        })
      )
    ).resolves.toBe(true);
  });
});

describe('Command integration – shell pipes & complex commands', () => {
  it('handles piped commands', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo "apple\nbanana\ncherry" | grep banana' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'banana' } },
        })
      )
    ).resolves.toBe(true);
  });

  it('handles multi-step commands with &&', async () => {
    await expect(
      executeTest(
        yaml({
          command: { command: 'echo first && echo second' },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'first' } },
        })
      )
    ).resolves.toBe(true);
  });
});
