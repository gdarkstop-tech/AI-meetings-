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

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'الأحد': 0, 'الاحد': 0, 'الإثنين': 1, 'الاثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3,
  'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
};

const DAY_MS = 86_400_000;

function atEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(17, 0, 0, 0); // default working-day deadline, 17:00 UTC
  return d;
}

export function resolveRelativeDue(phrase: string, referenceDate: Date): ResolvedDue {
  const source = phrase.trim();
  const text = source.toLowerCase();
  if (!text) return { dueAt: null, sourceText: source, interpretation: null };

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const parsed = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T17:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return { dueAt: parsed, sourceText: source, interpretation: `explicit date ${iso[0]}` };
    }
  }

  if (/\b(today|اليوم|النهارده|النهاردة)\b/.test(text)) {
    return { dueAt: atEndOfDay(referenceDate), sourceText: source, interpretation: 'today' };
  }
  if (/\b(tomorrow|بكرة|بكره|غدا|غدًا)\b/.test(text)) {
    return {
      dueAt: atEndOfDay(new Date(referenceDate.getTime() + DAY_MS)),
      sourceText: source,
      interpretation: 'the day after the meeting',
    };
  }
  if (/\b(end of week|نهاية الأسبوع|اخر الاسبوع)\b/.test(text)) {
    const ref = new Date(referenceDate);
    const delta = (5 - ref.getUTCDay() + 7) % 7 || 7;
    return {
      dueAt: atEndOfDay(new Date(ref.getTime() + delta * DAY_MS)),
      sourceText: source,
      interpretation: 'end of the meeting week',
    };
  }
  const inDays = text.match(/\bin (\d{1,2}) (day|days|أيام|يوم)\b/);
  if (inDays) {
    const n = Number(inDays[1]);
    return {
      dueAt: atEndOfDay(new Date(referenceDate.getTime() + n * DAY_MS)),
      sourceText: source,
      interpretation: `${n} day(s) after the meeting`,
    };
  }

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!text.includes(name.toLowerCase())) continue;
    const wantsNext = /\b(next|الجاي|القادم|المقبل)\b/.test(text);
    const ref = new Date(referenceDate);
    let delta = (weekday - ref.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (wantsNext && delta < 7) delta += 7;
    return {
      dueAt: atEndOfDay(new Date(ref.getTime() + delta * DAY_MS)),
      sourceText: source,
      interpretation: `${wantsNext ? 'next ' : ''}${name} after the meeting date`,
    };
  }

  return { dueAt: null, sourceText: source, interpretation: null };
}
