import { describe, expect, it } from 'vitest';
import manifest from '../package.json';

/**
 * Libauth initializes with top-level await, which `require()` cannot load, so a
 * CommonJS entry point would always throw. The package ships ESM only.
 */
describe('package entry points', () => {
  it('publishes ESM entry points only', () => {
    expect(manifest).not.toHaveProperty('main');
    expect(manifest.module).toBe('./dist/esm/index.mjs');
    expect(manifest.types).toBe('./dist/esm/index.d.mts');
    for (const [subpath, conditions] of Object.entries(manifest.exports)) {
      expect(Object.keys(conditions), subpath).toEqual(['import']);
      expect(conditions.import.default, subpath).toMatch(/^\.\/dist\/esm\/.+\.mjs$/);
      expect(conditions.import.types, subpath).toMatch(/^\.\/dist\/esm\/.+\.d\.mts$/);
    }
  });
});
