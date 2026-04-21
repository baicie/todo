import { defineConfig } from 'rolldown';

export default defineConfig([
  {
    input: 'src/index.ts',
    output: [
      { dir: 'dist/cjs', format: 'cjs' },
      { dir: 'dist/esm', format: 'esm' },
    ],
    external: ['react', '@tanstack/react-query', '@baicie/orbit'],
  },
]);
