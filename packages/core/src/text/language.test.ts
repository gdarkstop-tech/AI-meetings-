import { describe, expect, it } from 'vitest';
import { analyzeScript, detectScript, directionForLocale, directionOf } from './language.js';

describe('script detection', () => {
  it('labels Arabic, English and mixed text', () => {
    expect(detectScript('نحتاج إنهاء الموقع يوم الخميس')).toBe('ar');
    expect(detectScript('We need to finish the website by Thursday')).toBe('en');
    expect(detectScript('نحتاج نخلص الـ website قبل الـ deadline بتاع الخميس')).toBe('mixed');
  });

  it('returns unknown for text with no letters', () => {
    expect(detectScript('12:45 — 2026 !!')).toBe('unknown');
    expect(analyzeScript('').total).toBe(0);
  });

  it('computes direction from the dominant script', () => {
    expect(directionOf('نحتاج إنهاء الموقع')).toBe('rtl');
    expect(directionOf('finish the website')).toBe('ltr');
    expect(directionOf('12:45', 'rtl')).toBe('rtl'); // falls back, does not guess
  });

  it('maps locales to direction', () => {
    expect(directionForLocale('ar')).toBe('rtl');
    expect(directionForLocale('en')).toBe('ltr');
    expect(directionForLocale('fr')).toBe('ltr');
  });
});
