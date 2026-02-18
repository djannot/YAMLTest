'use strict';

/**
 * Unit tests for command expectation validation.
 *
 * We use executeTest with a real local command so we exercise the full
 * expectation pipeline without mocking child_process.
 */

import { describe, it, expect } from 'vitest';
import { executeTest } from '../../src/index.js';

// Helper: build a command test YAML string
function buildCommandYaml(command, expectations = {}) {
  return JSON.stringify({
    command: { command },
    source: { type: 'local' },
    expect: expectations,
  });
}

describe('validateCommandExpectations – exitCode', () => {
  it('passes when exit code matches', async () => {
    await expect(
      executeTest(buildCommandYaml('exit 0', { exitCode: 0 }))
    ).resolves.toBe(true);
  });

  it('throws when exit code does not match', async () => {
    await expect(
      executeTest(buildCommandYaml('exit 1', { exitCode: 0 }))
    ).rejects.toThrow(/Exit code mismatch/);
  });

  it('passes when exit code 1 is expected', async () => {
    await expect(
      executeTest(buildCommandYaml('exit 1', { exitCode: 1 }))
    ).resolves.toBe(true);
  });
});

describe('validateCommandExpectations – stdout', () => {
  it('passes when stdout contains expected substring', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "hello world"', {
          exitCode: 0,
          stdout: { contains: 'hello' },
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when stdout does not contain expected substring', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "hello world"', {
          exitCode: 0,
          stdout: { contains: 'goodbye' },
        })
      )
    ).rejects.toThrow(/contains/);
  });

  it('passes stdout equals check', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo -n "exact"', {
          exitCode: 0,
          stdout: { equals: 'exact' },
        })
      )
    ).resolves.toBe(true);
  });

  it('passes stdout regex match', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "version-1.2.3"', {
          exitCode: 0,
          stdout: { matches: 'version-\\d+\\.\\d+\\.\\d+' },
        })
      )
    ).resolves.toBe(true);
  });

  it('supports an array of stdout expectations', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "alpha beta gamma"', {
          exitCode: 0,
          stdout: [{ contains: 'alpha' }, { contains: 'gamma' }],
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when one expectation in array fails', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "alpha"', {
          exitCode: 0,
          stdout: [{ contains: 'alpha' }, { contains: 'missing' }],
        })
      )
    ).rejects.toThrow();
  });
});

describe('validateCommandExpectations – JSON output', () => {
  it('passes when JSON path matches', async () => {
    await expect(
      executeTest(
        JSON.stringify({
          command: {
            command: 'echo \'{"status":"ok","count":3}\'',
            parseJson: true,
          },
          source: { type: 'local' },
          expect: {
            exitCode: 0,
            jsonPath: [{ path: '$.status', comparator: 'equals', value: 'ok' }],
          },
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when JSON path value does not match', async () => {
    await expect(
      executeTest(
        JSON.stringify({
          command: {
            command: 'echo \'{"status":"error"}\'',
            parseJson: true,
          },
          source: { type: 'local' },
          expect: {
            exitCode: 0,
            jsonPath: [{ path: '$.status', comparator: 'equals', value: 'ok' }],
          },
        })
      )
    ).rejects.toThrow();
  });
});

describe('validateCommandExpectations – negation', () => {
  it('passes when stdout does not contain negated substring', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "everything is fine"', {
          exitCode: 0,
          stdout: { contains: 'error', negate: true },
        })
      )
    ).resolves.toBe(true);
  });

  it('throws when negated substring is present in stdout', async () => {
    await expect(
      executeTest(
        buildCommandYaml('echo "fatal error"', {
          exitCode: 0,
          stdout: { contains: 'error', negate: true },
        })
      )
    ).rejects.toThrow();
  });
});
