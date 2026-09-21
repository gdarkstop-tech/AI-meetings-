import { describe, expect, it } from 'vitest';
import {
  normalizeDigits,
  normalizeForDisplay,
  normalizeForSearch,
  stripArabicDiacritics,
  unifyArabicLetters,
} from './normalize.js';

describe('Arabic normalization', () => {
  it('fixes the exact defect measured in Phase 0 (tatweel breaks matching)', () => {
    // Phase 0: select similarity('الموقع','الموقـع') -> 0.5 in PostgreSQL.
    const plain = 'الموقع';
    const withTatweel = 'الموقـع';
    expect(withTatweel).not.toBe(plain);
    expect(normalizeForSearch(withTatweel)).toBe(normalizeForSearch(plain));
  });

  it('removes diacritics so vocalized and unvocalized spellings match', () => {
    expect(normalizeForSearch('مُحَمَّد')).toBe(normalizeForSearch('محمد'));
    expect(stripArabicDiacritics('مُحَمَّد')).toBe('محمد');
  });

  it('unifies alef forms', () => {
    const variants = ['أحمد', 'احمد', 'إحمد', 'آحمد'];
    const normalized = new Set(variants.map(normalizeForSearch));
    expect(normalized.size).toBe(1);
  });

  it('unifies ya / alef maqsura and ta marbuta', () => {
    expect(normalizeForSearch('على')).toBe(normalizeForSearch('علي'));
    expect(normalizeForSearch('شركة')).toBe(normalizeForSearch('شركه'));
    expect(unifyArabicLetters('مؤسسة')).toBe('موسسه');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    expect(normalizeDigits('٢٠٢٦')).toBe('2026');
    expect(normalizeDigits('۲۰۲۶')).toBe('2026');
    expect(normalizeForSearch('الموعد ٢٤ سبتمبر')).toContain('24');
  });

  it('strips zero-width and bidi control characters', () => {
    const sneaky = 'الم​وقع';
    expect(normalizeForSearch(sneaky)).toBe(normalizeForSearch('الموقع'));
  });

  it('handles mixed Arabic-English sentences', () => {
    const a = 'نحتاج ننهي الـ Website يوم الخميس';
    const b = 'نحتاج ننهي ال website يوم الخميس';
    expect(normalizeForSearch(a)).toBe(normalizeForSearch(b));
  });

  it('lowercases Latin text and collapses whitespace', () => {
    expect(normalizeForSearch('  Website   DEADLINE ')).toBe('website deadline');
  });

  it('never mutates spelling for display', () => {
    const original = 'مُحَمَّد قال: "الموقـع"';
    // Display keeps diacritics, tatweel and punctuation exactly as spoken/written.
    expect(normalizeForDisplay(original)).toBe(original);
    expect(normalizeForDisplay(original)).not.toBe(normalizeForSearch(original));
  });

  it('is idempotent', () => {
    const once = normalizeForSearch('مُحَمَّد ٢٠٢٦ Website');
    expect(normalizeForSearch(once)).toBe(once);
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalizeForSearch('')).toBe('');
    expect(normalizeForSearch('   ')).toBe('');
    expect(normalizeForDisplay('')).toBe('');
  });
});
