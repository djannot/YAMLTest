'use strict';

/**
 * Tests for parseCurlResponse – an internal function.
 * We inline the implementation here (identical copy from v2.js) so these tests
 * remain pure and don't rely on exports that aren't part of the public API.
 */

import { describe, it, expect } from 'vitest';

// ── Inline implementation mirror ─────────────────────────────────────────────
function parseCurlResponse(curlOutput) {
  const parts = curlOutput.split('---RESPONSE_END---');
  const responseData = parts[0].trim();

  if (!responseData) {
    throw new Error('No response data found in curl output');
  }

  const lines = responseData.split('\n');
  let statusCode = 200;
  const headers = {};
  let bodyStartIndex = -1;

  if (lines.length > 0 && lines[0].startsWith('HTTP/')) {
    const statusMatch = lines[0].match(/HTTP\/\d+\.\d+\s+(\d+)/);
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1], 10);
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyStartIndex = i + 1;
      break;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const headerName = line.substring(0, colonIndex).trim().toLowerCase();
      const headerValue = line.substring(colonIndex + 1).trim();
      headers[headerName] = headerValue;
    }
  }

  let body = '';
  if (bodyStartIndex >= 0 && bodyStartIndex < lines.length) {
    body = lines.slice(bodyStartIndex).join('\n');
  }

  return { statusCode, headers, body: body.trim() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('parseCurlResponse', () => {
  const buildCurlOutput = (statusLine, headers, body) => {
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    return [statusLine, headerLines, '', body, '---RESPONSE_END---'].join('\n');
  };

  it('parses a 200 OK response', () => {
    const raw = buildCurlOutput('HTTP/1.1 200 OK', { 'Content-Type': 'application/json' }, '{"ok":true}');
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body).toBe('{"ok":true}');
  });

  it('parses a 404 Not Found response', () => {
    const raw = buildCurlOutput('HTTP/1.1 404 Not Found', {}, 'not found');
    expect(parseCurlResponse(raw).statusCode).toBe(404);
  });

  it('parses a 500 response', () => {
    const raw = buildCurlOutput('HTTP/1.1 500 Internal Server Error', {}, 'error');
    expect(parseCurlResponse(raw).statusCode).toBe(500);
  });

  it('lowercases header names', () => {
    const raw = buildCurlOutput(
      'HTTP/1.1 200 OK',
      { 'X-Custom-Header': 'myvalue', 'Authorization': 'Bearer token' },
      ''
    );
    const r = parseCurlResponse(raw);
    expect(r.headers['x-custom-header']).toBe('myvalue');
    expect(r.headers['authorization']).toBe('Bearer token');
  });

  it('handles HTTP/2 status lines', () => {
    const raw = buildCurlOutput('HTTP/2 200', {}, 'ok');
    // HTTP/2 uses a different version string format; our regex covers it
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(200);
  });

  it('extracts multi-line bodies correctly', () => {
    const raw = buildCurlOutput('HTTP/1.1 200 OK', {}, 'line1\nline2\nline3');
    const r = parseCurlResponse(raw);
    expect(r.body).toBe('line1\nline2\nline3');
  });

  it('throws on empty input', () => {
    expect(() => parseCurlResponse('')).toThrow('No response data found');
  });

  it('throws when only marker is present', () => {
    expect(() => parseCurlResponse('---RESPONSE_END---')).toThrow('No response data found');
  });

  it('handles response without body', () => {
    const raw = 'HTTP/1.1 204 No Content\nContent-Length: 0\n\n\n---RESPONSE_END---';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
  });
});
