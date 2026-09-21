import { normalizeForSearch } from '../text/normalize.js';

/**
 * Relative date resolution for action items ("tomorrow", "next Tuesday",
 * "بكرة", "الخميس الجاي").
 *
 * The resolved date is always surfaced to the user next to the original phrase
 * so a wrong interpretation is visible and correctable — it is never applied
 * silently.
 */
export interface ResolvedDue {
  dueAt: Date | null;
  sourceText: string;
  interpretation: string | null;
}

/**
 * Weekday names in both scripts. Arabic keys are stored in their normalized
 * form (see normalizeForSearch) because JavaScript's \b word boundary is
 * ASCII-only and does not work for Arabic text.
 */
const WEEKDAYS: Array<{ match: string; weekday: number; arabic: boolean }> = [
  { match: 'sunday', weekday: 0, arabic: false },
  { match: 'monday', weekday: 1, arabic: false },
  { match: 'tuesday', weekday: 2, arabic: false },
  { match: 'wednesday', weekday: 3, arabic: false },
  { match: 'thursday', weekday: 4, arabic: false },
  { match: 'friday', weekday: 5, arabic: false },
  { match: 'saturday', weekday: 6, arabic: false },
  { match: 'الاحد', weekday: 0, arabic: true },
  { match: 'الاثنين', weekday: 1, arabic: true },
  { match: 'الثلاثاء', weekday: 2, arabic: true },
  { match: 'الاربعاء', weekday: 3, arabic: true },
  { match: 'الخميس', weekday: 4, arabic: true },
  { match: 'الجمعه', weekday: 5, arabic: true },
  { match: 'السبت', weekday: 6, arabic: true },
];

const DAY_MS = 86_400_000;

function atEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(17, 0, 0, 0); // default working-day deadline, 17:00 UTC
  return d;
}

export function resolveRelativeDue(phrase: string, referenceDate: Date): ResolvedDue {
  const source = phrase.trim();
  const text = source.toLowerCase();
  // Arabic is matched on the normalized form: alef/ya/ta-marbuta variants and
  // diacritics must not change the result.
  const arabic = normalizeForSearch(source);
  if (!text) return { dueAt: null, sourceText: source, interpretation: null };

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const parsed = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T17:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return { dueAt: parsed, sourceText: source, interpretation: `explicit date ${iso[0]}` };
    }
  }

  if (/\btoday\b/.test(text) || /اليوم|النهارده/.test(arabic)) {
    return { dueAt: atEndOfDay(referenceDate), sourceText: source, interpretation: 'today' };
  }
  if (/\btomorrow\b/.test(text) || /بكره|غدا/.test(arabic)) {
    return {
      dueAt: atEndOfDay(new Date(referenceDate.getTime() + DAY_MS)),
      sourceText: source,
      interpretation: 'the day after the meeting',
    };
  }
  if (/\bend of week\b/.test(text) || /نهايه الاسبوع|اخر الاسبوع/.test(arabic)) {
    const ref = new Date(referenceDate);
    const delta = (5 - ref.getUTCDay() + 7) % 7 || 7;
    return {
      dueAt: atEndOfDay(new Date(ref.getTime() + delta * DAY_MS)),
      sourceText: source,
      interpretation: 'end of the meeting week',
    };
  }
  const inDays = text.match(/\bin (\d{1,2}) days?\b/) ?? arabic.match(/خلال (\d{1,2}) (?:ايام|يوم)/);
  if (inDays) {
    const n = Number(inDays[1]);
    return {
      dueAt: atEndOfDay(new Date(referenceDate.getTime() + n * DAY_MS)),
      sourceText: source,
      interpretation: `${n} day(s) after the meeting`,
    };
  }

  for (const { match, weekday, arabic: isArabic } of WEEKDAYS) {
    const haystack = isArabic ? arabic : text;
    if (!haystack.includes(match)) continue;
    const wantsNext = /\bnext\b/.test(text) || /الجاي|القادم|المقبل/.test(arabic);
    const ref = new Date(referenceDate);
    let delta = (weekday - ref.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (wantsNext && delta < 7) delta += 7;
    return {
      dueAt: atEndOfDay(new Date(ref.getTime() + delta * DAY_MS)),
      sourceText: source,
      interpretation: `${wantsNext ? 'next ' : ''}${match} after the meeting date`,
    };
  }

  return { dueAt: null, sourceText: source, interpretation: null };
}
