// Buffer polyfill for environments that may not have it available globally.
// Uses dynamic require to avoid ESLint "no Node.js builtin" warnings on the
// static import form, while still allowing esbuild to bundle the `buffer`
// npm package (not the Node.js built-in).
const ensureBuffer = (): void => {
  if (typeof globalThis.Buffer !== "undefined") {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Buffer: BufferPolyfill } = require("buffer") as { Buffer: typeof globalThis.Buffer };
    (globalThis as unknown as { Buffer?: typeof globalThis.Buffer }).Buffer = BufferPolyfill;
  } catch {
    // Silently ignore if buffer package is unavailable
  }
};

ensureBuffer();
