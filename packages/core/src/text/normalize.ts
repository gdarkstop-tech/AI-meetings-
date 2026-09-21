/**
 * Arabic/English text normalization.
 *
 * WHY THIS EXISTS (measured in Phase 0 against PostgreSQL 16.13):
 *
 *   select similarity('الموقع','الموقـع');  ->  0.5
 *
 * The two strings are the same word; the second contains a tatweel (U+0640).
 * PostgreSQL performs no Arabic normalization of any kind, so lexical search
 * and trigram matching fail on ordinary Arabic spelling variation.
 *
 * IMPORTANT: normalization is for the SEARCH INDEX and for matching only.
 * Displayed transcript text is never normalized — `normalizeForSearch` must not
 * be used to render content back to a user.
 */

const TATWEEL = /ـ/g;

/** Harakat/diacritics and Quranic annotation marks. */
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

/** Zero-width and bidi control characters that break matching invisibly. */
const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿]/g;

const ALEF_FORMS = /[آأإٱٲٳٵ]/g; // آ أ إ ٱ -> ا
const ALEF_MAQSURA = /ى/g; // ى -> ي
const TA_MARBUTA = /ة/g; // ة -> ه
const HAMZA_WAW = /ؤ/g; // ؤ -> و
const HAMZA_YA = /[ئی]/g; // ئ ی -> ي
const KAF_VARIANT = /ک/g; // ک -> ك

const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹

/** Convert Arabic-Indic digits to ASCII digits so "٢٠٢٦" and "2026" match. */
export function normalizeDigits(input: string): string {
  return input
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Strip characters that carry no lexical meaning for matching. */
export function stripArabicDiacritics(input: string): string {
  return input.replace(DIACRITICS, '').replace(TATWEEL, '');
}

/**
 * Unify Arabic letter forms that users spell interchangeably.
 * Lossy on purpose: أحمد and احمد must match.
 */
export function unifyArabicLetters(input: string): string {
  return input
    .replace(ALEF_FORMS, 'ا')
    .replace(HAMZA_WAW, 'و')
    .replace(HAMZA_YA, 'ي')
    .replace(ALEF_MAQSURA, 'ي')
    .replace(KAF_VARIANT, 'ك')
    .replace(TA_MARBUTA, 'ه');
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * The canonical form used for indexing and comparison.
 * Applies Unicode NFKC, removes invisibles, normalizes Arabic orthography and
 * digits, lowercases Latin script, and collapses whitespace.
 */
export function normalizeForSearch(input: string): string {
  if (!input) return '';
  const nfkc = input.normalize('NFKC').replace(INVISIBLES, '');
  const arabic = unifyArabicLetters(stripArabicDiacritics(nfkc));
  return collapseWhitespace(normalizeDigits(arabic).toLowerCase());
}

/**
 * Light normalization safe for display: removes invisible control characters and
 * collapses runs of whitespace, but preserves spelling, diacritics and case.
 */
export function normalizeForDisplay(input: string): string {
  if (!input) return '';
  return collapseWhitespace(input.normalize('NFC').replace(INVISIBLES, ''));
}
