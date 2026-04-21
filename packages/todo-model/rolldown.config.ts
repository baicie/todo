import { defineConfig } from 'rolldown';

export default defineConfig([
  {
    input: 'src/index.ts',
    output: [
      {
        dir: 'dist/cjs',
        format: 'cjs',
      },
      {
        dir: 'dist/esm',
        format: 'esm',
      },
    ],
    external: ['axios', 'dexie', 'uuid'],
  },
]);
