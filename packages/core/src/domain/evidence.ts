import { normalizeForSearch } from '../text/normalize.js';

/**
 * Deterministic evidence validation for AI extractions.
 *
 * The model proposes; this function decides. An item survives only if every
 * segment id it cites exists in the meeting AND its quoted text actually
 * appears in those segments. Nothing here trusts the model's own claims, and
 * dropped items are counted and reported rather than silently discarded.
 */
export interface EvidenceSegment {
  id: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface EvidenceClaim {
  evidenceSegmentIds: string[];
  quote?: string | null;
}

export type DropReason = 'no_evidence' | 'unknown_segment' | 'quote_not_found';

export interface ValidationOutcome<T> {
  kept: Array<T & { startMs: number; endMs: number; evidenceSegmentIds: string[] }>;
  dropped: Array<{ item: T; reason: DropReason; detail?: string }>;
}

/** Loose containment check that tolerates ASR punctuation and Arabic spelling variance. */
export function quoteAppearsIn(quote: string, segmentTexts: string[]): boolean {
  const needle = normalizeForSearch(quote).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (needle.length < 3) return true; // too short to verify; other checks still apply
  const haystack = normalizeForSearch(segmentTexts.join(' ')).replace(/[^\p{L}\p{N} ]/gu, '');
  if (haystack.includes(needle)) return true;
  // Fall back to token overlap for paraphrased quotes: most words must be present.
  const tokens = needle.split(' ').filter((t) => t.length > 2);
  if (tokens.length === 0) return true;
  const present = tokens.filter((t) => haystack.includes(t)).length;
  return present / tokens.length >= 0.8;
}

export function validateEvidence<T extends EvidenceClaim>(
  items: T[],
  segments: EvidenceSegment[],
): ValidationOutcome<T> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const kept: ValidationOutcome<T>['kept'] = [];
  const dropped: ValidationOutcome<T>['dropped'] = [];

  for (const item of items) {
    const ids = Array.from(new Set(item.evidenceSegmentIds ?? []));
    if (ids.length === 0) {
      dropped.push({ item, reason: 'no_evidence' });
      continue;
    }
    const resolved = ids.map((id) => byId.get(id)).filter((s): s is EvidenceSegment => Boolean(s));
    if (resolved.length !== ids.length) {
      dropped.push({
        item,
        reason: 'unknown_segment',
        detail: ids.filter((id) => !byId.has(id)).join(','),
      });
      continue;
    }
    if (item.quote && !quoteAppearsIn(item.quote, resolved.map((s) => s.text))) {
      dropped.push({ item, reason: 'quote_not_found', detail: item.quote.slice(0, 120) });
      continue;
    }
    kept.push({
      ...item,
      evidenceSegmentIds: ids,
      startMs: Math.min(...resolved.map((s) => s.startMs)),
      endMs: Math.max(...resolved.map((s) => s.endMs)),
    });
  }
  return { kept, dropped };
}
