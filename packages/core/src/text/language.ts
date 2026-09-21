/**
 * Script detection for bilingual (ar/en) and code-switched content.
 *
 * Deterministic and cheap on purpose: it decides text direction for rendering
 * and gives the ASR layer a language hint. It is NOT a language identifier and
 * never reports a confidence it cannot compute.
 */
export type ScriptLabel = 'ar' | 'en' | 'mixed' | 'unknown';
export type Direction = 'rtl' | 'ltr';

const ARABIC_LETTER = /[ؠ-يٮ-ۓۺ-ۿݐ-ݿࢠ-ࣿ]/g;
const LATIN_LETTER = /[A-Za-z]/g;

export interface ScriptStats {
  arabic: number;
  latin: number;
  total: number;
  arabicRatio: number;
  label: ScriptLabel;
}

/** Minimum share of letters a second script needs before text counts as mixed. */
const MIXED_THRESHOLD = 0.15;

export function analyzeScript(input: string): ScriptStats {
  const arabic = (input.match(ARABIC_LETTER) ?? []).length;
  const latin = (input.match(LATIN_LETTER) ?? []).length;
  const total = arabic + latin;
  if (total === 0) {
    return { arabic, latin, total, arabicRatio: 0, label: 'unknown' };
  }
  const arabicRatio = arabic / total;
  let label: ScriptLabel;
  if (arabicRatio >= 1 - MIXED_THRESHOLD) label = 'ar';
  else if (arabicRatio <= MIXED_THRESHOLD) label = 'en';
  else label = 'mixed';
  return { arabic, latin, total, arabicRatio, label };
}

export function detectScript(input: string): ScriptLabel {
  return analyzeScript(input).label;
}

/**
 * Direction for a block of text. Mixed content follows the dominant script;
 * computed explicitly so server and client agree instead of relying on dir="auto".
 */
export function directionOf(input: string, fallback: Direction = 'ltr'): Direction {
  const stats = analyzeScript(input);
  if (stats.label === 'unknown') return fallback;
  return stats.arabicRatio > 0.5 ? 'rtl' : 'ltr';
}

export const LOCALE_DIRECTION: Record<string, Direction> = { ar: 'rtl', en: 'ltr' };

export function directionForLocale(locale: string): Direction {
  return LOCALE_DIRECTION[locale] ?? 'ltr';
}
