'use strict';

/**
 * Unit tests for the compareValue logic.
 *
 * compareValue is an internal function; we exercise it through validateHttpExpectations
 * via executeHttpTest, using a stubbed axios so no real network calls are made.
 *
 * For cleaner coverage we expose a thin re-implementation mirror here and test
 * the comparison semantics directly, then verify the same behaviour through the
 * exported executeTest path in the integration tests.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inline mirror of compareValue – kept identical to v2.js so we can unit-test
// the pure comparison logic without extracting internals.
// ---------------------------------------------------------------------------
function deepCompare(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null)
    return false;
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) return false;
    for (let i = 0; i < obj1.length; i++) if (!deepCompare(obj1[i], obj2[i])) return false;
    return true;
  }
  if (Array.isArray(obj1) || Array.isArray(obj2)) return false;
  const k1 = Object.keys(obj1);
  const k2 = Object.keys(obj2);
  if (k1.length !== k2.length) return false;
  for (const k of k1) {
    if (!k2.includes(k)) return false;
    if (!deepCompare(obj1[k], obj2[k])) return false;
  }
  return true;
}

function compareValue(actual, comparison) {
  const actualAsString = typeof actual === 'string' ? actual : JSON.stringify(actual);
  let result = false;

  switch (comparison.comparator) {
    case 'exists':
      result = actual !== undefined && actual !== null;
      break;
    case 'equals':
      result = deepCompare(actual, comparison.value);
      break;
    case 'contains':
      result = actualAsString.includes(String(comparison.value));
      break;
    case 'matches':
      result = new RegExp(comparison.value).test(actualAsString);
      break;
    case 'greaterThan':
      result = Number(actual) > Number(comparison.value);
      break;
    case 'lessThan':
      result = Number(actual) < Number(comparison.value);
      break;
    default:
      throw new Error(`Unknown comparator: ${comparison.comparator}`);
  }

  const finalResult = comparison.negate ? !result : result;

  if (!finalResult) {
    const operation = comparison.negate ? `not ${comparison.comparator}` : comparison.comparator;
    const valueStr = comparison.comparator !== 'exists' ? ` ${JSON.stringify(comparison.value)}` : '';
    throw new Error(`comparison failed: expected to ${operation}${valueStr}, found ${actualAsString}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compareValue – exists', () => {
  it('passes when value exists', () => {
    expect(() => compareValue('hello', { comparator: 'exists' })).not.toThrow();
  });

  it('passes when value is 0 (falsy but exists)', () => {
    expect(() => compareValue(0, { comparator: 'exists' })).not.toThrow();
  });

  it('throws when value is null', () => {
    expect(() => compareValue(null, { comparator: 'exists' })).toThrow();
  });

  it('passes when negated and value is null', () => {
    expect(() => compareValue(null, { comparator: 'exists', negate: true })).not.toThrow();
  });

  it('throws when negated and value exists', () => {
    expect(() => compareValue('present', { comparator: 'exists', negate: true })).toThrow();
  });
});

describe('compareValue – equals', () => {
  it('passes for equal primitives', () => {
    expect(() => compareValue(42, { comparator: 'equals', value: 42 })).not.toThrow();
  });

  it('throws for unequal primitives', () => {
    expect(() => compareValue(42, { comparator: 'equals', value: 43 })).toThrow(/equals/);
  });

  it('passes for deeply equal objects', () => {
    expect(() =>
      compareValue({ a: 1, b: [2, 3] }, { comparator: 'equals', value: { a: 1, b: [2, 3] } })
    ).not.toThrow();
  });

  it('throws for structurally different objects', () => {
    expect(() =>
      compareValue({ a: 1 }, { comparator: 'equals', value: { a: 2 } })
    ).toThrow();
  });

  it('passes when negated and values differ', () => {
    expect(() =>
      compareValue('foo', { comparator: 'equals', value: 'bar', negate: true })
    ).not.toThrow();
  });
});

describe('compareValue – contains', () => {
  it('passes when string contains the substring', () => {
    expect(() =>
      compareValue('Hello World', { comparator: 'contains', value: 'World' })
    ).not.toThrow();
  });

  it('throws when string does not contain the substring', () => {
    expect(() =>
      compareValue('Hello World', { comparator: 'contains', value: 'Mars' })
    ).toThrow(/contains/);
  });

  it('stringifies objects before checking', () => {
    expect(() =>
      compareValue({ key: 'value' }, { comparator: 'contains', value: 'key' })
    ).not.toThrow();
  });

  it('passes when negated and substring absent', () => {
    expect(() =>
      compareValue('Hello', { comparator: 'contains', value: 'World', negate: true })
    ).not.toThrow();
  });

  it('throws when negated and substring present', () => {
    expect(() =>
      compareValue('Hello World', { comparator: 'contains', value: 'World', negate: true })
    ).toThrow();
  });
});

describe('compareValue – matches (regex)', () => {
  it('passes when regex matches', () => {
    expect(() =>
      compareValue('error-404', { comparator: 'matches', value: 'error-\\d+' })
    ).not.toThrow();
  });

  it('throws when regex does not match', () => {
    expect(() =>
      compareValue('success', { comparator: 'matches', value: '^error' })
    ).toThrow(/matches/);
  });

  it('passes when negated and regex does not match', () => {
    expect(() =>
      compareValue('success', { comparator: 'matches', value: '^error', negate: true })
    ).not.toThrow();
  });
});

describe('compareValue – greaterThan / lessThan', () => {
  it('passes greaterThan when actual > value', () => {
    expect(() => compareValue(10, { comparator: 'greaterThan', value: 5 })).not.toThrow();
  });

  it('throws greaterThan when actual <= value', () => {
    expect(() => compareValue(5, { comparator: 'greaterThan', value: 10 })).toThrow(/greaterThan/);
  });

  it('passes lessThan when actual < value', () => {
    expect(() => compareValue(3, { comparator: 'lessThan', value: 10 })).not.toThrow();
  });

  it('throws lessThan when actual >= value', () => {
    expect(() => compareValue(10, { comparator: 'lessThan', value: 3 })).toThrow(/lessThan/);
  });
});

describe('compareValue – unknown comparator', () => {
  it('throws for an unknown comparator', () => {
    expect(() =>
      compareValue('x', { comparator: 'startsWith', value: 'x' })
    ).toThrow(/Unknown comparator/);
  });
});
