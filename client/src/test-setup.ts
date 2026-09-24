process.env.NODE_ENV = 'test'

import { afterEach } from 'vitest'

if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = class extends EventTarget {
    close(): void { /* test stub */ }
  } as unknown as typeof EventSource
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void { /* test stub */ }
    unobserve(): void { /* test stub */ }
    disconnect(): void { /* test stub */ }
  } as unknown as typeof ResizeObserver
}

afterEach(() => {
  document.body.innerHTML = ''
})
