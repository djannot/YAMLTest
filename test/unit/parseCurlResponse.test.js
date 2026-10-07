'use strict';

/**
 * Tests for parseCurlResponse – the internal parser for the `curl -i` output of
 * the usePodExec HTTP mode. These run against the real function (exported from
 * core.js for tests) rather than a copy, so they guard the code that ships.
 */

import { describe, it, expect } from 'vitest';
import { parseCurlResponse } from '../../src/core.js';

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

// curl sends "Expect: 100-continue" for a request body over 1 MiB, and `-i`
// then prints the interim "100 Continue" response before the real one.
describe('parseCurlResponse – interim 1xx responses', () => {
  it('skips a 100 Continue before the final response (CRLF, as curl prints it)', () => {
    const raw =
      'HTTP/1.1 100 Continue\r\n\r\n' +
      'HTTP/1.1 413 Payload Too Large\r\ncontent-type: text/plain\r\ncontent-length: 9\r\n\r\n' +
      'too large\n---RESPONSE_END---\n';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(413);
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.body).toBe('too large');
  });

  it('skips several interim responses, including ones with headers', () => {
    const raw =
      'HTTP/1.1 103 Early Hints\r\nlink: </style.css>; rel=preload\r\n\r\n' +
      'HTTP/1.1 100 Continue\r\n\r\n' +
      'HTTP/1.1 200 OK\r\nx-final: yes\r\n\r\n' +
      'done\n---RESPONSE_END---\n';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ 'x-final': 'yes' });
    expect(r.body).toBe('done');
  });

  it('skips an HTTP/2 interim response', () => {
    const raw = 'HTTP/2 100\r\n\r\nHTTP/2 201\r\nlocation: /x\r\n\r\ncreated\n---RESPONSE_END---\n';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(201);
    expect(r.headers.location).toBe('/x');
  });

  it('does not skip a body that happens to start like a status line', () => {
    const raw = 'HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 100 Continue\n---RESPONSE_END---\n';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('HTTP/1.1 100 Continue');
  });

  it('keeps a lone interim response when no final one arrived', () => {
    const r = parseCurlResponse('HTTP/1.1 100 Continue\r\n\r\n\n---RESPONSE_END---\n');
    expect(r.statusCode).toBe(100);
  });
});

// expect.bodySize without a body assertion: curl drops the body in the pod
// (-o /dev/null), dumps the headers (-D -), and prints %{size_download}.
describe('parseCurlResponse – header dump with the body size after the marker', () => {
  it('parses status and headers with an empty body', () => {
    const raw =
      'HTTP/1.1 100 Continue\r\n\r\n' +
      'HTTP/1.1 200 OK\r\ncontent-length: 5000000\r\n\r\n' +
      '\n---RESPONSE_END---\n5000000';
    const r = parseCurlResponse(raw);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('5000000');
    expect(r.body).toBe('');
  });
});
