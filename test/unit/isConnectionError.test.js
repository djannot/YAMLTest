'use strict';

/**
 * Unit tests for the connection-error helpers that back `expect.connectionError`.
 *
 * isConnectionError() decides whether a thrown error is a transport-level
 * failure (DNS/TCP/TLS) versus a completed response or a configuration error.
 * validateConnectionError() checks a caught error against the user's spec.
 */

import { describe, it, expect } from 'vitest';
import { isConnectionError, validateConnectionError } from '../../src/core.js';

// Build an axios-style error (no `.response` means the request never completed).
function axiosError(code, message) {
  const err = new Error(message || code);
  err.isAxiosError = true;
  err.code = code;
  return err;
}

describe('isConnectionError', () => {
  it('treats an axios error with no response as a connection error', () => {
    expect(isConnectionError(axiosError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'))).toBe(true);
  });

  it('classifies by axios-without-response, not by an error-code allowlist', () => {
    // Even an unrecognised code classifies as a connection error, because the
    // decision is "axios rejected without a response" — guards against anyone
    // reintroducing a hardcoded set of transport codes.
    const err = axiosError('ERR_SOMETHING_ODD');
    expect(isConnectionError(err)).toBe(true);
  });

  it('does NOT treat an axios error that has a response as a connection error', () => {
    const err = axiosError('ERR_BAD_RESPONSE');
    err.response = { status: 500 };
    expect(isConnectionError(err)).toBe(false);
  });

  it('does NOT classify a non-axios error, even with a transport code', () => {
    // Only the local axios path is auto-classified. A wrapped/non-axios error
    // (e.g. from the best-effort pod path) is left to fail loudly rather than
    // being silently treated as an expected connection failure.
    const err = new Error('getaddrinfo ENOTFOUND nope.invalid');
    err.code = 'ENOTFOUND';
    expect(isConnectionError(err)).toBe(false);
  });

  it('does NOT treat a plain configuration error as a connection error', () => {
    // e.g. an unreadable cert file — must fail the test loudly, not pass it.
    expect(isConnectionError(new Error('Failed to read certificate file: ENOENT'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

describe('validateConnectionError', () => {
  const err = axiosError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1');

  it('accepts any connection error when spec is true', () => {
    expect(() => validateConnectionError(err, true, 'test')).not.toThrow();
  });

  it('passes when the code matches', () => {
    expect(() => validateConnectionError(err, { code: 'ECONNREFUSED' }, 'test')).not.toThrow();
  });

  it('throws when the code does not match', () => {
    expect(() => validateConnectionError(err, { code: 'ETIMEDOUT' }, 'test'))
      .toThrow(/did not equal "ETIMEDOUT"/);
  });

  it('passes when contains matches the message', () => {
    expect(() => validateConnectionError(err, { contains: 'ECONNREFUSED' }, 'test')).not.toThrow();
  });

  it('throws when contains does not match the message', () => {
    expect(() => validateConnectionError(err, { contains: 'handshake' }, 'test'))
      .toThrow(/did not contain "handshake"/);
  });

  it('passes when matches (regex) matches the message', () => {
    expect(() => validateConnectionError(err, { matches: 'ECONN(REFUSED|RESET)' }, 'test')).not.toThrow();
  });

  it('throws when matches (regex) does not match the message', () => {
    expect(() => validateConnectionError(err, { matches: '^TLS' }, 'test'))
      .toThrow(/did not match/);
  });

  it('reads the code from error.cause when the top-level code is absent', () => {
    const tlsErr = new Error('certificate has expired');
    tlsErr.cause = { code: 'CERT_HAS_EXPIRED' };
    expect(() => validateConnectionError(tlsErr, { code: 'CERT_HAS_EXPIRED' }, 'test')).not.toThrow();
  });

  it('requires ALL constraints to hold (code + contains together)', () => {
    // code matches but the message does not contain the substring → still fails.
    expect(() => validateConnectionError(err, { code: 'ECONNREFUSED', contains: 'handshake' }, 'test'))
      .toThrow(/did not contain "handshake"/);
    // both hold → passes.
    expect(() => validateConnectionError(err, { code: 'ECONNREFUSED', contains: 'ECONNREFUSED' }, 'test'))
      .not.toThrow();
  });
});
