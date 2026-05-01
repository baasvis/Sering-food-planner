/**
 * Jest setupFiles entry — runs BEFORE test modules import. Provides minimal
 * browser-global stubs so frontend modules can be unit-tested in Node without
 * the full jsdom dependency.
 *
 * Modules like public/js/telemetry.ts touch `document.addEventListener` at
 * module load. They don't actually need a real DOM — just enough surface that
 * the no-op call succeeds silently.
 *
 * If a future test needs more DOM, prefer either (a) extending the stubs here,
 * or (b) installing jest-environment-jsdom and switching that test file to
 * the jsdom environment via a `/** @jest-environment jsdom *\/` directive.
 */

const noop = () => {};

const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v; },
  removeItem: (k: string) => { delete lsStore[k]; },
  clear: () => { Object.keys(lsStore).forEach(k => delete lsStore[k]); },
};

const documentStub = {
  addEventListener: noop,
  removeEventListener: noop,
  visibilityState: 'visible',
  hidden: false,
  referrer: '',
  title: '',
  body: { addEventListener: noop },
  documentElement: { classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, addEventListener: noop }),
};

const windowStub = {
  addEventListener: noop,
  removeEventListener: noop,
  location: { href: 'http://localhost/', pathname: '/', search: '' },
  history: { pushState: noop, replaceState: noop, back: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.localStorage) g.localStorage = localStorageStub;
if (!g.document) g.document = documentStub;
if (!g.window) g.window = windowStub;
if (!g.navigator) g.navigator = { userAgent: 'jest', sendBeacon: () => true };
if (!g.EventSource) g.EventSource = class { close() {} addEventListener() {} };

// Suppress module-load setInterval timers (e.g. telemetry's 30s flush timer
// in public/js/telemetry.ts). Without this, jest reports an open handle that
// keeps the process alive past --forceExit.
const realSetInterval = g.setInterval;
g.setInterval = (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
  // Only suppress timers shorter than 5min — long ones are likely test-internal.
  if (ms < 5 * 60_000) return 0;
  return realSetInterval(fn, ms, ...args);
};
