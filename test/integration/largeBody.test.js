'use strict';

/**
 * Integration tests for large request and response bodies:
 *   http.bodyFile, http.bodyGenerate  – streamed request bodies
 *   expect.bodySize                   – counted (not buffered) response bodies
 *
 * A real local HTTP server (test/fixtures/body-echo-server.js) hashes and counts
 * what it receives and can send a response of any size without buffering it.
 *
 * The "1 GiB" tests run the client in a child process (test/fixtures/rss-driver.js)
 * and check that its memory does not grow with the body. Set
 * YAMLTEST_LARGE_BODY_BYTES to change the size (default 1 GiB; the bodyFile test
 * writes a temporary file of that size).
 */

import http from 'http';
import zlib from 'zlib';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeTest } from '../../src/index.js';
import { runTests } from '../../src/runner.js';
import { bodyEchoHandler } from '../fixtures/body-echo-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RSS_DRIVER = path.join(__dirname, '../fixtures/rss-driver.js');

const MiB = 1024 * 1024;
const LARGE = Number(process.env.YAMLTEST_LARGE_BODY_BYTES || 1024 * MiB);
// A streamed transfer holds a bounded amount of memory whatever its size: up to
// ~64 MiB of 64 KiB socket/file read buffers waiting for V8's next GC, plus the
// stream buffers. Buffering a 1 GiB body would add at least 1 GiB.
const MAX_MEMORY_GROWTH = 256 * MiB;

const FIXED_JSON = JSON.stringify({ status: 'ok', items: [1, 2, 3], note: 'fixed body' });

// ── Local test server ─────────────────────────────────────────────────────────

let server;
let baseUrl;
let dir;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-large-body-'));
  server = http.createServer((req, res) => {
    // Answers before reading the body and closes, like a size limit or a WAF.
    if (req.url === '/early-413') {
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
      res.end('payload too large');
      return;
    }
    const gzip = /^\/gzip\/(\d+)$/.exec(req.url);
    if (gzip) {
      const body = zlib.gzipSync(Buffer.alloc(Number(gzip[1]), 'y'));
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.url === '/fixed-json') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-42' });
      res.end(FIXED_JSON);
      return;
    }
    bodyEchoHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function yaml(obj) {
  return JSON.stringify(obj);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Asserts on the echo server's JSON summary of the request body it received.
function received(fields) {
  return Object.entries(fields).map(([key, value]) => ({ path: `$.${key}`, comparator: 'equals', value }));
}

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the test to fail');
}

// Bytes that a shell or a ${VAR} substitution would mangle, plus every byte value.
const TRICKY_BYTES = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from('"double" \'single\' $HOME ${HOME} ${YT_BODY_NOT_SUBSTITUTED} `tick` \\ \r\n'),
]);

// ── http.bodyFile ─────────────────────────────────────────────────────────────

describe('http.bodyFile (local)', () => {
  let file;

  beforeAll(() => {
    file = path.join(dir, 'tricky.bin');
    fs.writeFileSync(file, TRICKY_BYTES);
  });

  it('streams the file byte for byte, with Content-Length from its size', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'POST', path: '/echo', bodyFile: file },
      source: { type: 'local' },
      expect: {
        statusCode: 200,
        bodyJsonPath: received({
          bytes: TRICKY_BYTES.length,
          sha256: sha256(TRICKY_BYTES),
          contentLength: String(TRICKY_BYTES.length),
          transferEncoding: null,
          method: 'POST',
        }),
      },
    }))).resolves.toBe(true);
  });

  it('resolves ${VAR} in the path but never in the file contents', async () => {
    process.env.YT_BODY_DIR = dir;
    process.env.YT_BODY_NOT_SUBSTITUTED = 'should-not-appear';
    try {
      await expect(executeTest(yaml({
        http: { url: baseUrl, method: 'PUT', path: '/echo', bodyFile: '${YT_BODY_DIR}/tricky.bin' },
        source: { type: 'local' },
        expect: { statusCode: 200, bodyJsonPath: received({ sha256: sha256(TRICKY_BYTES), method: 'PUT' }) },
      }))).resolves.toBe(true);
    } finally {
      delete process.env.YT_BODY_DIR;
      delete process.env.YT_BODY_NOT_SUBSTITUTED;
    }
  });

  it('sends the body chunked when the test sets Transfer-Encoding: chunked', async () => {
    await expect(executeTest(yaml({
      http: {
        url: baseUrl, method: 'POST', path: '/echo', bodyFile: file,
        headers: { 'Transfer-Encoding': 'chunked' },
      },
      source: { type: 'local' },
      expect: {
        statusCode: 200,
        bodyJsonPath: received({ sha256: sha256(TRICKY_BYTES), contentLength: null, transferEncoding: 'chunked' }),
      },
    }))).resolves.toBe(true);
  });

  it('fails at once on a missing file, without retrying, naming the path', async () => {
    const missing = path.join(dir, 'does-not-exist.bin');
    const run = await runTests(yaml([{
      name: 'missing body file',
      retries: 5,
      http: { url: baseUrl, method: 'POST', path: '/echo', bodyFile: missing },
      source: { type: 'local' },
      expect: { statusCode: 200 },
    }]));
    expect(run.failed).toBe(1);
    expect(run.results[0].attempts).toBe(1);
    expect(run.results[0].error).toBe(`http.bodyFile not found: ${missing}`);
    expect(run.results[0].observed.request.bodyFile).toBe(missing);
  });

  it('names the resolved path when it came from ${VAR}', async () => {
    process.env.YT_BODY_DIR = dir;
    try {
      const error = await failureOf(executeTest(yaml({
        http: { url: baseUrl, method: 'POST', bodyFile: '${YT_BODY_DIR}/nope.bin' },
        source: { type: 'local' },
        expect: { statusCode: 200 },
      })));
      expect(error.message).toBe(`http.bodyFile not found: ${path.join(dir, 'nope.bin')}`);
      expect(error.retryable).toBe(false);
    } finally {
      delete process.env.YT_BODY_DIR;
    }
  });

  it('does not let expect.connectionError swallow a missing file', async () => {
    await expect(executeTest(yaml({
      http: { url: 'http://127.0.0.1:1', method: 'POST', bodyFile: path.join(dir, 'missing.bin') },
      source: { type: 'local' },
      expect: { connectionError: true },
    }))).rejects.toThrow(/http.bodyFile not found/);
  });

  it('works in both httpBodyComparison requests', async () => {
    process.env.YT_BODY_DIR = dir;
    try {
      const request = {
        http: { url: baseUrl, method: 'POST', path: '/echo', bodyFile: '${YT_BODY_DIR}/tricky.bin' },
        source: { type: 'local' },
      };
      await expect(executeTest(yaml({
        httpBodyComparison: { request1: request, request2: request, parseAsJson: true },
      }))).resolves.toBe(true);
    } finally {
      delete process.env.YT_BODY_DIR;
    }
  });
});

// ── http.bodyGenerate ─────────────────────────────────────────────────────────

describe('http.bodyGenerate (local)', () => {
  it('sends exactly size bytes: fill repeated, suffix last', async () => {
    const spec = { size: 300000, fill: 'abc', suffix: 'blocked-request-body' };
    const expected = Buffer.concat([
      Buffer.alloc(spec.size - spec.suffix.length, spec.fill),
      Buffer.from(spec.suffix),
    ]);
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'POST', path: '/echo', headers: { 'Content-Type': 'text/plain' }, bodyGenerate: spec },
      source: { type: 'local' },
      expect: {
        statusCode: 200,
        bodyJsonPath: received({
          bytes: spec.size,
          sha256: sha256(expected),
          contentLength: String(spec.size),
          head: 'abcabcabcabcabcabcabcabcabcabcab',
          tail: expected.subarray(-64).toString('latin1'),
        }),
      },
    }))).resolves.toBe(true);
  });

  it('defaults fill to "a"', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'PATCH', path: '/echo', bodyGenerate: { size: 40, suffix: 'END' } },
      source: { type: 'local' },
      expect: {
        statusCode: 200,
        bodyJsonPath: received({ bytes: 40, method: 'PATCH', tail: `${'a'.repeat(37)}END` }),
      },
    }))).resolves.toBe(true);
  });

  it('reports a status sent before the body was read (e.g. a size limit) despite the reset', async () => {
    // The server answers and closes without reading the body. The client must
    // report the 413, not the EPIPE of the unfinished upload. Rarely the reset
    // still wins the race (see yieldBetweenChunks in core.js); a retry covers it.
    const run = await runTests(yaml([{
      name: 'early 413',
      retries: 5,
      http: { url: baseUrl, method: 'POST', path: '/early-413', bodyGenerate: { size: 32 * MiB } },
      source: { type: 'local' },
      expect: { statusCode: 413, bodyContains: 'payload too large' },
    }]));
    expect(run.results[0].error).toBeNull();
    expect(run.passed).toBe(1);
  });
});

// ── expect.bodySize ───────────────────────────────────────────────────────────

describe('expect.bodySize (local)', () => {
  it('counts a response body that is not otherwise asserted', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/bytes/5000000' },
      source: { type: 'local' },
      expect: { statusCode: 200, bodySize: 5000000, headers: [{ name: 'content-length', comparator: 'equals', value: '5000000' }] },
    }))).resolves.toBe(true);
  });

  it('fails on a size mismatch and reports the size and the start of the body', async () => {
    const error = await failureOf(executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/bytes/100000' },
      source: { type: 'local' },
      expect: { statusCode: 200, bodySize: 99999 },
    })));
    expect(error.message).toBe('Body size mismatch: expected 99999 bytes, got 100000 bytes');
    expect(error.observed.response.bodySize).toBe(100000);
    expect(error.observed.response.bodyTruncated).toBe(true);
    expect(error.observed.response.body).toBe('x'.repeat(4096));
  });

  it('keeps all of a small body for the failure report', async () => {
    const error = await failureOf(executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/fixed-json' },
      source: { type: 'local' },
      expect: { statusCode: 404, bodySize: Buffer.byteLength(FIXED_JSON) },
    })));
    expect(error.message).toMatch(/Status code mismatch/);
    expect(error.observed.response.body).toBe(FIXED_JSON);
    expect(error.observed.response.bodyTruncated).toBe(false);
  });

  it('works alongside body assertions, which still see the decoded body', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/fixed-json' },
      source: { type: 'local' },
      expect: {
        statusCode: 200,
        bodySize: Buffer.byteLength(FIXED_JSON),
        bodyContains: 'fixed body',
        bodyJsonPath: [{ path: '$.items[2]', comparator: 'equals', value: 3 }],
        body: JSON.parse(FIXED_JSON),
      },
    }))).resolves.toBe(true);
  });

  it('keeps the body for setVars rules that read it', async () => {
    delete process.env.YT_SIZED_STATUS;
    try {
      await executeTest(yaml({
        http: { url: baseUrl, method: 'GET', path: '/fixed-json' },
        source: { type: 'local' },
        expect: { statusCode: 200, bodySize: Buffer.byteLength(FIXED_JSON) },
        setVars: { YT_SIZED_STATUS: { jsonPath: '$.status' }, YT_SIZED_REQ: { header: 'x-request-id' } },
      }));
      expect(process.env.YT_SIZED_STATUS).toBe('ok');
      expect(process.env.YT_SIZED_REQ).toBe('req-42');
    } finally {
      delete process.env.YT_SIZED_STATUS;
      delete process.env.YT_SIZED_REQ;
    }
  });

  it('counts the decoded bytes of a compressed response', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'GET', path: '/gzip/250000' },
      source: { type: 'local' },
      expect: { statusCode: 200, bodySize: 250000 },
    }))).resolves.toBe(true);
  });

  it('works with an inline body, which is sent as before', async () => {
    await expect(executeTest(yaml({
      http: { url: baseUrl, method: 'POST', path: '/echo', body: '{"msg":"hello"}' },
      source: { type: 'local' },
      expect: { statusCode: 200, bodyJsonPath: received({ bytes: 15, sha256: sha256(Buffer.from('{"msg":"hello"}')) }) },
    }))).resolves.toBe(true);
  });
});

// ── 1 GiB transfers: client memory stays flat ─────────────────────────────────

/** Run `defs` in the RSS driver (a fresh process) and return its memory report. */
function runInDriver(defs) {
  const warmup = yaml([
    { http: { url: baseUrl, method: 'POST', path: '/echo', bodyFile: path.join(dir, 'warmup.bin') }, source: { type: 'local' }, expect: { statusCode: 200 } },
    { http: { url: baseUrl, method: 'POST', path: '/echo', bodyGenerate: { size: 4096 } }, source: { type: 'local' }, expect: { statusCode: 200 } },
    { http: { url: baseUrl, method: 'GET', path: '/bytes/4096' }, source: { type: 'local' }, expect: { statusCode: 200, bodySize: 4096 } },
  ]);
  fs.writeFileSync(path.join(dir, 'warmup.bin'), 'warm');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RSS_DRIVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`rss-driver exited with ${code}: ${stderr}`));
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify({ warmup, yaml: yaml(defs) }));
  });
}

function logMemory(label, report) {
  const mib = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`;
  const footprint = report.footprint
    ? `physical footprint ${mib(report.footprint.baseline)} -> peak ${mib(report.footprint.peak)}; `
    : '';
  console.log(
    `[large-body] ${label}, ${mib(LARGE)}: memory growth ${mib(report.growth)} ` +
    `(${footprint}RSS ${mib(report.baselineRss)} -> peak ${mib(report.peakRss)}, maxRSS ${mib(report.maxRss)}) ` +
    `in ${(report.durationMs / 1000).toFixed(2)}s`
  );
}

describe(`${(LARGE / MiB).toFixed(0)} MiB bodies keep client memory flat`, () => {
  let bigFile;
  let bigFileSha;

  beforeAll(() => {
    // Random-looking blocks, so the hash would catch a reordered or repeated chunk.
    bigFile = path.join(dir, 'large.bin');
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(bigFile, 'w');
    try {
      const block = crypto.randomBytes(MiB);
      for (let written = 0, n = 0; written < LARGE; n += 1) {
        block.writeUInt32BE(n, 0);
        const chunk = block.subarray(0, Math.min(block.length, LARGE - written));
        fs.writeSync(fd, chunk);
        hash.update(chunk);
        written += chunk.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    bigFileSha = hash.digest('hex');
  });

  afterAll(() => {
    if (bigFile) fs.rmSync(bigFile, { force: true });
  });

  it('request body from bodyFile', async () => {
    const report = await runInDriver([{
      timeout: 600000,
      http: { url: baseUrl, method: 'POST', path: '/echo', bodyFile: bigFile },
      source: { type: 'local' },
      expect: { statusCode: 200, bodyJsonPath: received({ bytes: LARGE, sha256: bigFileSha }) },
    }]);
    logMemory('bodyFile upload', report);
    expect(report.result.results[0].error).toBeNull();
    expect(report.growth).toBeLessThan(MAX_MEMORY_GROWTH);
  });

  it('request body from bodyGenerate', async () => {
    const report = await runInDriver([{
      timeout: 600000,
      http: { url: baseUrl, method: 'POST', path: '/echo', bodyGenerate: { size: LARGE, suffix: 'blocked-request-body' } },
      source: { type: 'local' },
      expect: { statusCode: 200, bodyJsonPath: received({ bytes: LARGE }), bodyContains: 'aaaaaablocked-request-body"' },
    }]);
    logMemory('bodyGenerate upload', report);
    expect(report.result.results[0].error).toBeNull();
    expect(report.growth).toBeLessThan(MAX_MEMORY_GROWTH);
  });

  it('response asserted only by statusCode and bodySize', async () => {
    const report = await runInDriver([{
      timeout: 600000,
      http: { url: baseUrl, method: 'GET', path: `/bytes/${LARGE}` },
      source: { type: 'local' },
      expect: { statusCode: 200, bodySize: LARGE },
    }]);
    logMemory('bodySize download', report);
    expect(report.result.results[0].error).toBeNull();
    expect(report.growth).toBeLessThan(MAX_MEMORY_GROWTH);
  });
});
