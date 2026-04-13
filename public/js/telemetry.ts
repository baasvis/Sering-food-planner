// ─────────────────────────────────────────────────────────────────────────────
// FRONTEND TELEMETRY — collects errors, screen views, and feature usage
// ─────────────────────────────────────────────────────────────────────────────

import type { TelemetryPayload } from '@shared/types';

const sessionId = crypto.randomUUID();
let userId: string | undefined;
let buffer: TelemetryPayload[] = [];

// Screen view duration tracking
let lastScreen = '';
let lastScreenTime = 0;

// ── Public API ──

export function initTelemetry(userEmail?: string): void {
  userId = userEmail;
}

export function trackScreenView(screenName: string): void {
  const now = Date.now();
  // Record duration of previous screen
  if (lastScreen && lastScreenTime) {
    addEvent('screen_view', lastScreen, { duration: now - lastScreenTime });
  }
  lastScreen = screenName;
  lastScreenTime = now;
}

export function trackEvent(action: string, label?: string, data?: Record<string, unknown>): void {
  addEvent('feature_use', action, { ...data, label });
}

export function trackError(message: string, data?: Record<string, unknown>): void {
  addEvent('error', message.slice(0, 500), data);
}

// ── Internal ──

function addEvent(type: TelemetryPayload['type'], name: string, data?: Record<string, unknown>): void {
  if (buffer.length >= 500) return; // cap buffer size
  buffer.push({
    source: 'frontend',
    type,
    name,
    data,
    userId,
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

function flushEvents(): void {
  if (buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);
  const body = JSON.stringify(events);
  const blob = new Blob([body], { type: 'application/json' });
  const ok = navigator.sendBeacon('/api/telemetry', blob);
  if (!ok) {
    // Fallback to fetch
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  }
}

// Flush every 30 seconds
setInterval(flushEvents, 30_000);

// Flush when page is hidden (user navigates away or closes tab)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushEvents();
});

// ── Global error handlers ──

window.addEventListener('error', (e) => {
  trackError(e.message || 'Unknown error', {
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  trackError(reason, { type: 'unhandledrejection' });
});
