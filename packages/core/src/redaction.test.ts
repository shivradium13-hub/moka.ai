import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, redactObject, redactString, redactValue } from './redaction.js';

describe('isSensitiveKey', () => {
  it('flags credential-bearing key names', () => {
    for (const key of [
      'password',
      'passphrase',
      'apiKey',
      'api_key',
      'ANTHROPIC_API_KEY',
      'secret',
      'accessToken',
      'authorization',
      'cookie',
      'ciphertext',
      'dekWrapped',
      'authTag',
      'iv',
      'privateKey',
    ]) {
      expect(isSensitiveKey(key), `${key} should be sensitive`).toBe(true);
    }
  });

  it('leaves ordinary field names alone', () => {
    for (const key of ['name', 'email', 'organizationId', 'createdAt', 'keyboard', 'monkey']) {
      expect(isSensitiveKey(key), `${key} should not be sensitive`).toBe(false);
    }
  });
});

describe('redactString', () => {
  it('redacts provider key shapes wherever they appear', () => {
    expect(redactString('using sk-abcdefghijklmnopqrstuvwxyz012345')).toContain(REDACTED);
    expect(redactString('key sk-ant-api03-abcdefghijklmnopqrst')).toContain(REDACTED);
    expect(redactString('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toContain(REDACTED);
  });

  it('redacts bearer tokens and JWTs', () => {
    expect(redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain(REDACTED);
    expect(
      redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    ).toContain(REDACTED);
  });

  it('redacts connection strings', () => {
    const out = redactString('failed: postgresql://moka_app:hunter2@127.0.0.1:5432/moka_ai');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('hunter2');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('project created successfully')).toBe('project created successfully');
  });
});

describe('redactValue', () => {
  it('replaces values under sensitive keys wholesale', () => {
    const out = redactObject({ name: 'Alpha', password: 'hunter2', apiKey: 'sk-live-xyz' });
    expect(out).toEqual({ name: 'Alpha', password: REDACTED, apiKey: REDACTED });
  });

  it('redacts nested structures', () => {
    const out = redactObject({
      user: { email: 'a@example.test', credentials: { token: 'abc' } },
      items: [{ secret: 'x' }, { label: 'safe' }],
    });
    expect(out).toEqual({
      user: { email: 'a@example.test', credentials: REDACTED },
      items: [{ secret: REDACTED }, { label: 'safe' }],
    });
  });

  it('never serialises binary buffers, which may hold key material', () => {
    expect(redactObject({ blob: Buffer.from('raw key bytes') })).toEqual({ blob: REDACTED });
    expect(redactObject({ arr: new Uint8Array([1, 2, 3]) })).toEqual({ arr: REDACTED });
  });

  it('redacts secret-shaped values even under innocent key names', () => {
    const out = redactObject({ note: 'the key is sk-abcdefghijklmnopqrstuvwxyz012345' });
    expect(out['note']).toContain(REDACTED);
  });

  // The logger must never be the thing that crashes a request.
  it('survives circular references', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    expect(() => redactObject(circular)).not.toThrow();
    expect(redactObject(circular)['self']).toBe('[CIRCULAR]');
  });

  it('truncates beyond maximum depth rather than recursing forever', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).toContain('TRUNCATED');
  });

  it('reduces Errors to name and message, dropping the stack', () => {
    const out = redactValue(new Error('failed with sk-abcdefghijklmnopqrstuvwxyz012345')) as Record<
      string,
      unknown
    >;
    expect(out['name']).toBe('Error');
    expect(out['message']).toContain(REDACTED);
    expect(out['stack']).toBeUndefined();
  });

  it('passes through primitives unchanged', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
  });
});
