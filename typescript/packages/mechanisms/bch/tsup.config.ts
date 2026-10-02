import { defineConfig } from 'tsup';

// ESM only: Libauth initializes with top-level await, which require() cannot load.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'exact/client/index': 'src/exact/client/index.ts',
    'exact/server/index': 'src/exact/server/index.ts',
    'exact/facilitator/index': 'src/exact/facilitator/index.ts',
  },
  dts: { resolve: true },
  sourcemap: true,
  target: 'es2020',
  format: 'esm',
  outDir: 'dist/esm',
  clean: true,
});
