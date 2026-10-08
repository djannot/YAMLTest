'use strict';

/**
 * Unit tests for the large-body helpers in core.js:
 *   createGeneratedBodyStream – http.bodyGenerate
 *   openRequestBody           – http.bodyFile / http.bodyGenerate
 *   responseBodyPlan          – when expect.bodySize lets the response stream
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGeneratedBodyStream, openRequestBody, responseBodyPlan } from '../../src/core.js';

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// What bodyGenerate must produce: `fill` repeated over size - suffix bytes, then the suffix.
function expectedBody({ size, fill = 'a', suffix = '' }) {
  const suffixBytes = Buffer.from(suffix, 'utf8');
  const filler = Buffer.alloc(size - suffixBytes.length, Buffer.from(fill, 'utf8'));
  return Buffer.concat([filler, suffixBytes]);
}

// ── createGeneratedBodyStream ────────────────────────────────────────────────

describe('createGeneratedBodyStream', () => {
  const cases = [
    { size: 0 },
    { size: 0, suffix: '' },
    { size: 1 },
    { size: 5, fill: 'ab' },
    { size: 5, fill: 'ab', suffix: 'Z' },
    { size: 3, fill: 'q', suffix: 'xyz' },                     // suffix only
    { size: 5, fill: 'é' },                                    // 2-byte fill, cut mid-character
    { size: 64 * 1024, fill: 'a' },                            // exactly one block
    { size: 64 * 1024 + 1, fill: 'a' },                        // one byte into a second block
    { size: 3 * 64 * 1024 + 17, fill: 'xyz', suffix: 'END' },  // 3-byte fill: block is 65535 bytes
    // fill longer than a block, and not uniform, so a misplaced repetition shows
    { size: 300 * 1024, fill: Array.from({ length: 100 * 1024 + 7 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''), suffix: 'tail' },
    { size: 1000, fill: '0123456789', suffix: 'blocked-request-body' },
  ];

  for (const spec of cases) {
    it(`produces exactly ${JSON.stringify({ ...spec, fill: spec.fill && spec.fill.length > 20 ? `<${spec.fill.length} chars>` : spec.fill })}`, async () => {
      const body = await collect(createGeneratedBodyStream(spec));
      expect(body.length).toBe(spec.size);
      expect(body.equals(expectedBody(spec))).toBe(true);
    });
  }

  it('defaults fill to "a" and suffix to nothing', async () => {
    const body = await collect(createGeneratedBodyStream({ size: 10 }));
    expect(body.toString()).toBe('aaaaaaaaaa');
  });

  it('streams in chunks of at most 64 KiB', async () => {
    let largest = 0;
    let count = 0;
    for await (const chunk of createGeneratedBodyStream({ size: 1024 * 1024 + 3, suffix: 'end' })) {
      largest = Math.max(largest, chunk.length);
      count += 1;
    }
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(count).toBeGreaterThan(16);
  });

  it('rejects a suffix longer than size, as a non-retryable error', () => {
    let error;
    try {
      createGeneratedBodyStream({ size: 3, suffix: 'abcd' });
    } catch (e) {
      error = e;
    }
    expect(error.message).toMatch(/bodyGenerate cannot produce 3 bytes/);
    expect(error.retryable).toBe(false);
  });

  it('rejects an empty fill when filler bytes are needed', () => {
    expect(() => createGeneratedBodyStream({ size: 4, fill: '' })).toThrow(/bodyGenerate cannot produce/);
  });
});

// ── openRequestBody ──────────────────────────────────────────────────────────

describe('openRequestBody', () => {
  let dir;
  let file;
  const content = Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from('"double" \'single\' $HOME ${HOME} `tick`\r\n\0end'),
  ]);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamltest-reqbody-'));
    file = path.join(dir, 'body.bin');
    fs.writeFileSync(file, content);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null without bodyFile / bodyGenerate (inline body or none)', async () => {
    expect(await openRequestBody({})).toBeNull();
    expect(await openRequestBody({ body: 'inline' })).toBeNull();
  });

  it('streams a bodyFile byte for byte and reports its size', async () => {
    const body = await openRequestBody({ bodyFile: file });
    expect(body.size).toBe(content.length);
    expect(body.source).toBe(`bodyFile ${file}`);
    expect((await collect(body.stream)).equals(content)).toBe(true);
  });

  it('resolves a relative bodyFile against the working directory', async () => {
    const body = await openRequestBody({ bodyFile: path.relative(process.cwd(), file) });
    expect(body.source).toBe(`bodyFile ${file}`);
    body.stream.destroy();
  });

  it('fails on a missing bodyFile with a non-retryable error naming the path', async () => {
    const missing = path.join(dir, 'missing.bin');
    const error = await openRequestBody({ bodyFile: missing }).catch((e) => e);
    expect(error.message).toBe(`http.bodyFile not found: ${missing}`);
    expect(error.retryable).toBe(false);
  });

  it('fails on a directory with a non-retryable error naming the path', async () => {
    const error = await openRequestBody({ bodyFile: dir }).catch((e) => e);
    expect(error.message).toBe(`http.bodyFile is not a regular file: ${dir}`);
    expect(error.retryable).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails on an unreadable bodyFile with a non-retryable error naming the path',
    async () => {
      const locked = path.join(dir, 'locked.bin');
      fs.writeFileSync(locked, 'secret');
      fs.chmodSync(locked, 0o000);
      try {
        const error = await openRequestBody({ bodyFile: locked }).catch((e) => e);
        expect(error.message).toBe(`http.bodyFile cannot be read: ${locked} (EACCES)`);
        expect(error.retryable).toBe(false);
      } finally {
        fs.chmodSync(locked, 0o600);
      }
    }
  );

  it('streams a bodyGenerate body and reports its size', async () => {
    const body = await openRequestBody({ bodyGenerate: { size: 70000, fill: 'xy', suffix: '!' } });
    expect(body.size).toBe(70000);
    expect((await collect(body.stream)).equals(expectedBody({ size: 70000, fill: 'xy', suffix: '!' }))).toBe(true);
  });
});

// ── responseBodyPlan ─────────────────────────────────────────────────────────

describe('responseBodyPlan', () => {
  const buffered = { measureSize: false, keepBody: true };
  const counted = { measureSize: true, keepBody: false };
  const kept = { measureSize: true, keepBody: true };

  it('buffers the body as before when bodySize is not asserted', () => {
    expect(responseBodyPlan({ expect: { statusCode: 200 } })).toEqual(buffered);
    expect(responseBodyPlan({ expect: { bodyContains: 'x' } })).toEqual(buffered);
    expect(responseBodyPlan({})).toEqual(buffered); // httpBodyComparison request
  });

  it('only counts the body when nothing else reads it', () => {
    expect(responseBodyPlan({ expect: { bodySize: 10 } })).toEqual(counted);
    expect(responseBodyPlan({
      expect: { statusCode: 200, bodySize: 10, headers: [{ name: 'x', comparator: 'exists' }] },
      setVars: { STATUS: { statusCode: true }, ETAG: { header: 'etag' } },
    })).toEqual(counted);
  });

  for (const key of ['body', 'bodyContains', 'bodyRegex', 'bodyJsonPath']) {
    it(`keeps the body for expect.${key}`, () => {
      expect(responseBodyPlan({ expect: { bodySize: 10, [key]: key === 'bodyJsonPath' ? [] : 'x' } })).toEqual(kept);
    });
  }

  for (const [name, rule] of Object.entries({
    jsonPath: { jsonPath: '$.id' },
    body: { body: true },
    regex: { regex: { pattern: '(x)' } },
  })) {
    it(`keeps the body for a setVars ${name} rule`, () => {
      expect(responseBodyPlan({ expect: { bodySize: 10 }, setVars: { V: rule } })).toEqual(kept);
    });
  }
});
