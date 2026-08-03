'use strict';

/**
 * Integration tests for command test execution.
 *
 * Runs real local shell commands so the entire command pipeline is exercised:
 * executeTest → executeCommandTest → executeLocalCommand → child_process.spawn
 */

import { describe, it, expect, vi } from 'vitest';
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

  it('does not kill itself when the command pkills a pattern contained in its own text', async () => {
    // Regression: when commands ran as `sh -c "<script>"`, the shell's argv WAS the
    // script text, so a `pkill -f "<pattern-in-the-script>"` matched and killed the
    // test shell itself (exit code null). Running the command from a temp file keeps
    // the script body off the shell's command line, so this must now survive.
    const marker = `yamltest_selfmatch_marker_${process.pid}`;
    await expect(
      executeTest(
        yaml({
          command: { command: `echo "${marker}"; pkill -f "${marker}" 2>/dev/null || true; echo survived; exit 0` },
          source: { type: 'local' },
          expect: { exitCode: 0, stdout: { contains: 'survived' } },
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

describe('Command integration – output streaming', () => {
  // Capture everything written to process.stdout during the run so we can assert
  // whether the command's own output was teed through live. mockImplementation
  // keeps the marker out of the real test output.
  function captureStdout() {
    const chunks = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(chunk.toString());
      return true;
    });
    return {
      restore: () => spy.mockRestore(),
      sawMarker: (m) => chunks.some((c) => c.includes(m)),
    };
  }

  it('tees command stdout to process.stdout when stream: true', async () => {
    const marker = `yamltest_stream_marker_${process.pid}`;
    const cap = captureStdout();
    try {
      await expect(
        executeTest(
          yaml({
            command: { command: `echo "${marker}"`, stream: true },
            source: { type: 'local' },
            expect: { exitCode: 0, stdout: { contains: marker } },
          })
        )
      ).resolves.toBe(true);
    } finally {
      cap.restore();
    }
    expect(cap.sawMarker(marker)).toBe(true);
  });

  it('does not tee command output when stream is not set', async () => {
    const marker = `yamltest_nostream_marker_${process.pid}`;
    const cap = captureStdout();
    try {
      await expect(
        executeTest(
          yaml({
            command: { command: `echo "${marker}"` },
            source: { type: 'local' },
            expect: { exitCode: 0, stdout: { contains: marker } },
          })
        )
      ).resolves.toBe(true);
    } finally {
      cap.restore();
    }
    // The command still runs and its output is captured for the assertion above,
    // but nothing is echoed live.
    expect(cap.sawMarker(marker)).toBe(false);
  });
});
