'use strict';

import { describe, it, expect } from 'vitest';
import { filterJsonByJsonPath } from '../../src/index.js';

describe('filterJsonByJsonPath', () => {
  it('returns the object unchanged when no paths are provided', () => {
    const obj = { a: 1, b: 2 };
    expect(filterJsonByJsonPath(obj, [])).toEqual(obj);
  });

  it('returns the object unchanged when paths is not an array', () => {
    const obj = { a: 1 };
    expect(filterJsonByJsonPath(obj, null)).toEqual(obj);
  });

  it('removes a top-level key by JSONPath', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = filterJsonByJsonPath(obj, ['$.b']);
    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('removes a nested key by JSONPath', () => {
    const obj = { user: { name: 'Alice', age: 30 } };
    const result = filterJsonByJsonPath(obj, ['$.user.age']);
    expect(result).toEqual({ user: { name: 'Alice' } });
  });

  it('removes an array element by index', () => {
    const obj = { items: [1, 2, 3] };
    const result = filterJsonByJsonPath(obj, ['$.items[1]']);
    expect(result).toEqual({ items: [1, 3] });
  });

  it('does not mutate the original object', () => {
    const obj = { a: 1, b: 2 };
    const original = JSON.stringify(obj);
    filterJsonByJsonPath(obj, ['$.b']);
    expect(JSON.stringify(obj)).toBe(original);
  });

  it('handles multiple paths', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = filterJsonByJsonPath(obj, ['$.a', '$.c']);
    expect(result).toEqual({ b: 2 });
  });

  it('silently ignores a path that matches nothing', () => {
    const obj = { a: 1 };
    expect(() => filterJsonByJsonPath(obj, ['$.nonexistent'])).not.toThrow();
    expect(filterJsonByJsonPath(obj, ['$.nonexistent'])).toEqual({ a: 1 });
  });

  it('removes deeply nested timestamps (real-world use case)', () => {
    const obj = {
      data: { id: 1, createdAt: '2024-01-01', value: 42 },
    };
    const result = filterJsonByJsonPath(obj, ['$.data.createdAt']);
    expect(result).toEqual({ data: { id: 1, value: 42 } });
  });
});
