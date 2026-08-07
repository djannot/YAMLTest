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

describe('Command integration – echo output', () => {
  // Capture everything written to the given std stream during the run so we can
  // assert whether the command's own output was teed through live.
  // mockImplementation keeps the marker out of the real test output.
  function captureStream(streamName = 'stdout') {
    const chunks = [];
    const spy = vi.spyOn(process[streamName], 'write').mockImplementation((chunk) => {
      chunks.push(chunk.toString());
      return true;
    });
    return {
      restore: () => spy.mockRestore(),
      sawMarker: (m) => chunks.some((c) => c.includes(m)),
    };
  }

  it('tees command stdout to process.stdout when echo: true', async () => {
    const marker = `yamltest_echo_marker_${process.pid}`;
    const cap = captureStream('stdout');
    try {
      await expect(
        executeTest(
          yaml({
            command: { command: `echo "${marker}"`, echo: true },
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

  it('tees command stdout to process.stdout when YAMLTEST_ECHO=true', async () => {
    const marker = `yamltest_envecho_marker_${process.pid}`;
    const prev = process.env.YAMLTEST_ECHO;
    process.env.YAMLTEST_ECHO = 'true';
    const cap = captureStream('stdout');
    try {
      await expect(
        executeTest(
          yaml({
            // No per-test echo flag — the env var alone must enable echo.
            command: { command: `echo "${marker}"` },
            source: { type: 'local' },
            expect: { exitCode: 0, stdout: { contains: marker } },
          })
        )
      ).resolves.toBe(true);
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.YAMLTEST_ECHO;
      else process.env.YAMLTEST_ECHO = prev;
    }
    expect(cap.sawMarker(marker)).toBe(true);
  });

  it('tees command stderr to process.stderr when echo: true', async () => {
    const marker = `yamltest_stderr_marker_${process.pid}`;
    const cap = captureStream('stderr');
    try {
      await expect(
        executeTest(
          yaml({
            // Writes only to stderr and exits 0.
            command: { command: `echo "${marker}" >&2`, echo: true },
            source: { type: 'local' },
            expect: { exitCode: 0, stderr: { contains: marker } },
          })
        )
      ).resolves.toBe(true);
    } finally {
      cap.restore();
    }
    expect(cap.sawMarker(marker)).toBe(true);
  });

  it('does not tee command output when echo is not set', async () => {
    const marker = `yamltest_noecho_marker_${process.pid}`;
    const cap = captureStream('stdout');
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

describe('Command integration – echo warning on pod tests', () => {
  // A label-selector pod test whose kubectl lookup fails fast (no reachable
  // cluster), so executeTest rejects *after* the echo warning branch has run.
  // Pointing KUBECONFIG at a nonexistent file makes kubectl error immediately
  // instead of hanging, which lets these tests short-circuit before kubectl exec.
  function podTest(commandConfig) {
    return yaml({
      command: commandConfig,
      source: {
        type: 'pod',
        selector: {
          kind: 'Pod',
          metadata: { namespace: 'default', labels: { app: 'demo' } },
        },
      },
      expect: { exitCode: 0 },
    });
  }

  const POD_WARNING = 'echo is not supported for pod command tests';

  function withNoCluster(fn) {
    return async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Point kubectl at a bogus kubeconfig so the pod lookup fails fast, and
      // clear any inherited echo flag. vi.stubEnv snapshots the originals;
      // vi.unstubAllEnvs restores them, so there's no manual save/restore.
      vi.stubEnv('KUBECONFIG', '/nonexistent-yamltest-kubeconfig');
      vi.stubEnv('YAMLTEST_ECHO', '');
      try {
        await fn(warnSpy);
      } finally {
        warnSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    };
  }

  function podWarnings(warnSpy) {
    return warnSpy.mock.calls.filter((c) => String(c[0]).includes(POD_WARNING));
  }

  it(
    'warns when a pod command test explicitly sets echo: true',
    withNoCluster(async (warnSpy) => {
      // The kubectl lookup fails (no cluster), so the test rejects — but the
      // echo warning fires before kubectl runs, which is what we assert.
      await expect(executeTest(podTest({ command: 'echo hi', echo: true }))).rejects.toThrow();
      expect(podWarnings(warnSpy)).toHaveLength(1);
    })
  );

  it(
    'does not warn on a pod command test when only YAMLTEST_ECHO is set',
    withNoCluster(async (warnSpy) => {
      vi.stubEnv('YAMLTEST_ECHO', 'true');
      // No per-test echo flag: the global env var is a blanket "echo where
      // supported" toggle and must stay silent on the pod path.
      await expect(executeTest(podTest({ command: 'echo hi' }))).rejects.toThrow();
      expect(podWarnings(warnSpy)).toHaveLength(0);
    })
  );

  it(
    'does not warn on a pod command test when echo is unset',
    withNoCluster(async (warnSpy) => {
      await expect(executeTest(podTest({ command: 'echo hi' }))).rejects.toThrow();
      expect(podWarnings(warnSpy)).toHaveLength(0);
    })
  );
});
