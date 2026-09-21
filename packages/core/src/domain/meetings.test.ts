import { describe, expect, it } from 'vitest';
import { canTransition, consentSatisfied, retentionExpiry } from './meetings.js';

describe('meeting state machine', () => {
  it('allows the real processing path', () => {
    expect(canTransition('draft', 'uploaded')).toBe(true);
    expect(canTransition('uploaded', 'processing')).toBe(true);
    expect(canTransition('processing', 'ready')).toBe(true);
  });

  it('refuses to jump straight from failed or draft to ready', () => {
    expect(canTransition('failed', 'ready')).toBe(false);
    expect(canTransition('draft', 'ready')).toBe(false);
  });

  it('allows a failed meeting to be retried', () => {
    expect(canTransition('failed', 'processing')).toBe(true);
  });
});

describe('recording consent gate', () => {
  it('blocks capture when the workspace requires consent and none is recorded', () => {
    const result = consentSatisfied({ workspaceRequiresConsent: true, consentObtained: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/consent/i);
  });

  it('requires a consent method, not just a checkbox', () => {
    const result = consentSatisfied({ workspaceRequiresConsent: true, consentObtained: true, consentMethod: null });
    expect(result.ok).toBe(false);
  });

  it('passes when consent is recorded with a method', () => {
    expect(consentSatisfied({ workspaceRequiresConsent: true, consentObtained: true, consentMethod: 'verbal' }).ok).toBe(true);
  });

  it('passes when the workspace policy does not require consent', () => {
    expect(consentSatisfied({ workspaceRequiresConsent: false, consentObtained: false }).ok).toBe(true);
  });
});

describe('retention', () => {
  it('derives media and record expiry from workspace policy', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const { mediaExpiresAt, recordExpiresAt } = retentionExpiry({
      createdAt,
      retentionDays: 365,
      mediaRetentionDays: 30,
    });
    expect(mediaExpiresAt.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(recordExpiresAt.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  it('falls back to the record retention when no media policy is set', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const { mediaExpiresAt } = retentionExpiry({ createdAt, retentionDays: 90, mediaRetentionDays: null });
    expect(mediaExpiresAt.toISOString().slice(0, 10)).toBe('2026-04-01');
  });
});
