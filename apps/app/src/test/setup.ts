import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

if (!window.crypto?.randomUUID) {
  Object.defineProperty(window, 'crypto', {
    value: {
      ...window.crypto,
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (array: Uint8Array) => {
        array.fill(1);
        return array;
      },
    },
  });
}
