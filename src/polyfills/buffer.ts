import { Buffer as BufferPolyfill } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer?: typeof BufferPolyfill }).Buffer = BufferPolyfill;
}
