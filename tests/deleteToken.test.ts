import { describe, expect, it } from 'vitest';
import {
  deleteToken,
  isValidObjectPath,
  constantTimeEqual,
  authorizeUnpublish,
} from '../supabase/functions/_shared/deleteToken';

describe('deleteToken', () => {
  it('is deterministic base64url for the same secret+path', async () => {
    const a = await deleteToken('s3cr3t', 'neon-cat-abc.html');
    const b = await deleteToken('s3cr3t', 'neon-cat-abc.html');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no '=' padding
  });
  it('differs across paths and across secrets', async () => {
    expect(await deleteToken('s', 'a.html')).not.toBe(await deleteToken('s', 'b.html'));
    expect(await deleteToken('s1', 'a.html')).not.toBe(await deleteToken('s2', 'a.html'));
  });
});

describe('isValidObjectPath', () => {
  it('accepts real publish paths', () => {
    expect(isValidObjectPath('neon-cat-550e8400-e29b-41d4-a716-446655440000.html')).toBe(true);
    expect(isValidObjectPath('showcase-abc.html')).toBe(true);
  });
  it('rejects traversal, slashes, uppercase, and non-html keys', () => {
    for (const p of ['../secret.html', 'a/b.html', 'file.png', 'UPPER.html', '.html', 'no-ext', 'a.html/x', '']) {
      expect(isValidObjectPath(p)).toBe(false);
    }
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});

describe('authorizeUnpublish', () => {
  const secret = 'test-secret';
  it('ok for a matching token', async () => {
    const path = 'neon-cat-abc.html';
    const token = await deleteToken(secret, path);
    expect(await authorizeUnpublish(secret, path, token)).toEqual({ ok: true });
  });
  it('403 for a wrong token', async () => {
    const r = await authorizeUnpublish(secret, 'neon-cat-abc.html', 'wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.error).toMatch(/ownership/i); }
  });
  it('400 for a bad path even with a "valid" token for that path', async () => {
    const bad = '../evil.html';
    const r = await authorizeUnpublish(secret, bad, await deleteToken(secret, bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
  it('400 for a missing token', async () => {
    const r = await authorizeUnpublish(secret, 'a.html', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});
