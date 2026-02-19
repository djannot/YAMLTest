'use strict';

/**
 * End-to-end tests for the YAMLTest CLI binary.
 *
 * Spawns the actual `node src/cli.js` process and asserts on exit code + stdout.
 * The HTTP server is started as a separate child process to avoid conflicts
 * with Vitest's worker thread stdin/stdout management.
 */

import { spawn, spawnSync } from 'child_process';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'src/cli.js');
const NODE = process.execPath;

// ── Embedded test HTTP server (written to a temp file and spawned) ────────────

let serverProcess;
let serverPort;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

beforeAll(async () => {
  serverPort = await getFreePort();

  // Write a minimal HTTP server script to a temp file
  const serverScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('healthy');
    return;
  }
  if (req.url === '/json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ userId: 1, id: 42, title: 'buy groceries', completed: false }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"id":"1"}\\ndata: [DONE]\\n');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
server.listen(${serverPort}, '127.0.0.1', () => {
  process.stdout.write('READY\\n');
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;
  const tmpScript = path.join(os.tmpdir(), `yamltest-e2e-server-${Date.now()}.js`);
  fs.writeFileSync(tmpScript, serverScript);

  await new Promise((resolve, reject) => {
    serverProcess = spawn(NODE, [tmpScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });
    serverProcess.__tmpScript = tmpScript;

    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);

    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}, 15000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    if (serverProcess.__tmpScript) {
      try { fs.unlinkSync(serverProcess.__tmpScript); } catch (_) {}
    }
  }
});

// ── CLI invocation helper ─────────────────────────────────────────────────────

function runCli(yaml, args = ['-f', '-'], env = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    input: yaml,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: 15000,
  });
}

function base() {
  return `http://127.0.0.1:${serverPort}`;
}

// ── Help / usage ──────────────────────────────────────────────────────────────

describe('CLI e2e – help', () => {
  it('prints usage with --help and exits 0', () => {
    const r = runCli('', ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('YAMLTest');
    expect(r.stdout).toContain('-f');
  });

  it('exits 1 and prints error when no -f flag is given', () => {
    const r = runCli('', []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No input specified');
  });
});

// ── Passing tests ─────────────────────────────────────────────────────────────

describe('CLI e2e – passing tests', () => {
  it('exits 0 when a single HTTP test passes', () => {
    const yaml = JSON.stringify({
      name: 'health-check',
      http: { url: base(), method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200, bodyContains: 'healthy' },
    });
    const r = runCli(yaml);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('health-check');
    expect(r.stdout).toContain('1 passed');
  });

  it('exits 0 when multiple tests all pass', () => {
    const yaml = JSON.stringify([
      { name: 'test-1', http: { url: base(), method: 'GET', path: '/health' }, source: { type: 'local' }, expect: { statusCode: 200 } },
      { name: 'test-2', http: { url: base(), method: 'GET', path: '/health' }, source: { type: 'local' }, expect: { statusCode: 200 } },
    ]);
    const r = runCli(yaml);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 passed');
  });

  it('exits 0 when a command test passes', () => {
    const yaml = JSON.stringify({
      name: 'cmd-test',
      command: { command: 'echo hello' },
      source: { type: 'local' },
      expect: { exitCode: 0, stdout: { contains: 'hello' } },
    });
    const r = runCli(yaml);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cmd-test');
  });

  it('simulates the README streaming chat completions example', () => {
    const yaml = JSON.stringify({
      name: 'streaming-chat',
      retries: 1,
      http: {
        url: base(),
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-nano', messages: [{ role: 'user', content: 'Hello' }], stream: true }),
      },
      source: { type: 'local' },
      expect: { statusCode: 200, bodyContains: 'data:' },
    });
    const r = runCli(yaml);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 passed');
  });
});

// ── Failing tests ─────────────────────────────────────────────────────────────

describe('CLI e2e – failing tests', () => {
  it('exits 1 when a test fails', () => {
    const yaml = JSON.stringify({
      name: 'should-fail',
      http: { url: base(), method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 404 },
    });
    const r = runCli(yaml);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('1 failed');
    expect(r.stdout).toContain('should-fail');
  });

  it('exits 1 and shows skipped count on fail-fast', () => {
    const yaml = JSON.stringify([
      { name: 'pass',    http: { url: base(), method: 'GET', path: '/health' }, source: { type: 'local' }, expect: { statusCode: 200 } },
      { name: 'fail',    http: { url: base(), method: 'GET', path: '/health' }, source: { type: 'local' }, expect: { statusCode: 999 } },
      { name: 'skipped', http: { url: base(), method: 'GET', path: '/health' }, source: { type: 'local' }, expect: { statusCode: 200 } },
    ]);
    const r = runCli(yaml);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('1 passed');
    expect(r.stdout).toContain('1 failed');
    expect(r.stdout).toContain('1 skipped');
  });

  it('exits 1 on empty stdin', () => {
    const r = runCli('');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Empty input');
  });

  it('exits 1 on invalid YAML', () => {
    const r = runCli('{ broken yaml: [');
    expect(r.status).toBe(1);
  });
});

// ── File input ────────────────────────────────────────────────────────────────

describe('CLI e2e – reading from a file', () => {
  it('reads YAML from a file path and exits 0 on success', () => {
    const tmpFile = path.join(os.tmpdir(), `yamltest-e2e-${Date.now()}.yaml`);
    const yaml = JSON.stringify({
      name: 'file-test',
      http: { url: base(), method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
    });
    fs.writeFileSync(tmpFile, yaml);
    try {
      const r = runCli('', ['-f', tmpFile]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('file-test');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('exits 1 when file does not exist', () => {
    const r = runCli('', ['-f', '/nonexistent/path/file.yaml']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('File not found');
  });
});

// ── capture field ─────────────────────────────────────────────────────────────

describe('CLI e2e – capture', () => {
  it('writes captured JSON values to --save-env and they can be sourced', () => {
    const envFile = path.join(os.tmpdir(), `yamltest-capture-${Date.now()}.sh`);
    const yaml = JSON.stringify({
      name: 'capture-test',
      http: { url: base(), method: 'GET', path: '/json' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
      capture: { TODO_ID: '$.id', TODO_TITLE: '$.title' },
    });
    try {
      const r = runCli(yaml, ['-f', '-', '--save-env', envFile]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('capture-test');

      // Verify the env file was written
      expect(fs.existsSync(envFile)).toBe(true);
      const content = fs.readFileSync(envFile, 'utf8');
      expect(content).toContain("export TODO_ID='42'");
      expect(content).toContain("export TODO_TITLE='buy groceries'");

      // Verify the CLI printed a source instruction
      expect(r.stdout).toContain(`source ${envFile}`);
    } finally {
      try { fs.unlinkSync(envFile); } catch (_) {}
    }
  });

  it('does not write an env file when no vars are captured', () => {
    const envFile = path.join(os.tmpdir(), `yamltest-capture-empty-${Date.now()}.sh`);
    const yaml = JSON.stringify({
      name: 'no-capture',
      http: { url: base(), method: 'GET', path: '/health' },
      source: { type: 'local' },
      expect: { statusCode: 200 },
    });
    try {
      const r = runCli(yaml, ['-f', '-', '--save-env', envFile]);
      expect(r.status).toBe(0);
      // No vars captured → file should NOT be written
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      try { fs.unlinkSync(envFile); } catch (_) {}
    }
  });
});
