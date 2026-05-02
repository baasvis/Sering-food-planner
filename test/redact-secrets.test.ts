// Unit tests for redactSecrets — protects credentials from leaking into HTTP
// responses, telemetry, and Tebi/Hanos stderr captures.

import { redactSecrets, safeErrMsg } from '../lib/config';

describe('redactSecrets', () => {
  it('returns empty for empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('passes through text with no secret patterns', () => {
    expect(redactSecrets('Failed to connect to database')).toBe('Failed to connect to database');
  });

  it('redacts password=value', () => {
    expect(redactSecrets('error password=hunter2 failed')).toBe('error password=*** failed');
  });

  it('redacts password: value (with colon)', () => {
    expect(redactSecrets('login {password: hunter2}')).toBe('login {password: ***}');
  });

  it('redacts client_secret', () => {
    expect(redactSecrets('client_secret=abc123def')).toBe('client_secret=***');
  });

  it('redacts token, secret, api_key', () => {
    expect(redactSecrets('token=xyz')).toBe('token=***');
    expect(redactSecrets('secret=xyz')).toBe('secret=***');
    expect(redactSecrets('api_key=xyz')).toBe('api_key=***');
    expect(redactSecrets('api-key=xyz')).toBe('api-key=***');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGc.payload.sig'))
      .toBe('Authorization: Bearer ***');
  });

  it('redacts Basic auth', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz'))
      .toBe('Authorization: Basic ***');
  });

  it('is case-insensitive on key names', () => {
    expect(redactSecrets('Password=hunter2')).toBe('Password=***');
    expect(redactSecrets('PASSWORD=hunter2')).toBe('PASSWORD=***');
  });

  it('redacts multiple secrets in one string', () => {
    const input = 'password=foo and token=bar at the same time';
    const result = redactSecrets(input);
    expect(result).toContain('password=***');
    expect(result).toContain('token=***');
    expect(result).not.toContain('foo');
    expect(result).not.toContain('bar');
  });

  it('does not redact unrelated key=value pairs', () => {
    expect(redactSecrets('username=alice action=login')).toBe('username=alice action=login');
  });
});

describe('safeErrMsg', () => {
  it('returns "Unknown error" for non-Error values', () => {
    expect(safeErrMsg('plain string')).toBe('Unknown error');
    expect(safeErrMsg(null)).toBe('Unknown error');
    expect(safeErrMsg(42)).toBe('Unknown error');
  });

  it('returns the message for Error instances', () => {
    expect(safeErrMsg(new Error('Database connection refused')))
      .toBe('Database connection refused');
  });

  it('redacts secrets from Error messages', () => {
    expect(safeErrMsg(new Error('OAuth failed: client_secret=abc xyz')))
      .toBe('OAuth failed: client_secret=*** xyz');
  });
});
