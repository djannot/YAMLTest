'use strict';

/**
 * Unit tests for environment variable resolution.
 * We test the logic inline (mirrored from v2.js).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mirror of resolveEnvVarsInString from v2.js ───────────────────────────────
function resolveEnvVarsInString(value) {
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      return match; // leave unresolved
    }
    return resolved;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveEnvVarsInString', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.MY_HOST = 'localhost';
    process.env.MY_PORT = '8080';
    process.env.API_TOKEN = 'secret';
  });

  afterEach(() => {
    // Restore env to avoid test pollution
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL);
  });

  it('resolves a simple $VAR reference', () => {
    expect(resolveEnvVarsInString('http://$MY_HOST')).toBe('http://localhost');
  });

  it('resolves ${VAR} brace syntax', () => {
    expect(resolveEnvVarsInString('http://${MY_HOST}:${MY_PORT}')).toBe('http://localhost:8080');
  });

  it('resolves multiple variables in the same string', () => {
    expect(resolveEnvVarsInString('$MY_HOST:$MY_PORT')).toBe('localhost:8080');
  });

  it('leaves unset variable references unchanged', () => {
    const result = resolveEnvVarsInString('Bearer $UNDEFINED_TOKEN');
    expect(result).toBe('Bearer $UNDEFINED_TOKEN');
  });

  it('handles strings with no env vars', () => {
    expect(resolveEnvVarsInString('https://example.com/api')).toBe('https://example.com/api');
  });

  it('resolves lowercase variable names (case-insensitive regex)', () => {
    process.env.my_lower = 'value';
    expect(resolveEnvVarsInString('$my_lower')).toBe('value');
    delete process.env.my_lower;
  });

  it('resolves bearer token in header string', () => {
    expect(resolveEnvVarsInString('Bearer ${API_TOKEN}')).toBe('Bearer secret');
  });

  it('handles empty string input', () => {
    expect(resolveEnvVarsInString('')).toBe('');
  });
});
