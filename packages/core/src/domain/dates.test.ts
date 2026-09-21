import { describe, expect, it } from 'vitest';
import { resolveRelativeDue } from './dates.js';

// Meeting held on Monday 21 September 2026.
const meetingDate = new Date('2026-09-21T10:00:00Z');

describe('relative due-date resolution', () => {
  it('resolves English relative phrases against the meeting date', () => {
    expect(resolveRelativeDue('tomorrow', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-22');
    expect(resolveRelativeDue('today', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(resolveRelativeDue('in 3 days', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-24');
  });

  it('resolves Arabic relative phrases', () => {
    expect(resolveRelativeDue('بكرة', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-22');
    expect(resolveRelativeDue('يوم الخميس', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-24');
  });

  it('resolves weekdays, and "next" pushes a further week', () => {
    expect(resolveRelativeDue('Thursday', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(resolveRelativeDue('next Tuesday', meetingDate).dueAt?.toISOString().slice(0, 10)).toBe('2026-09-29');
  });

  it('accepts an explicit ISO date', () => {
    const resolved = resolveRelativeDue('by 2026-10-05 please', meetingDate);
    expect(resolved.dueAt?.toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(resolved.interpretation).toContain('explicit date');
  });

  it('returns no date rather than guessing when the phrase is unclear', () => {
    const resolved = resolveRelativeDue('as soon as possible', meetingDate);
    expect(resolved.dueAt).toBeNull();
    expect(resolved.interpretation).toBeNull();
  });

  it('always reports the interpretation so a user can correct it', () => {
    const resolved = resolveRelativeDue('tomorrow', meetingDate);
    expect(resolved.sourceText).toBe('tomorrow');
    expect(resolved.interpretation).toBe('the day after the meeting');
  });
});
