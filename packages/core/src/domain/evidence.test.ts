import { describe, expect, it } from 'vitest';
import { quoteAppearsIn, validateEvidence, type EvidenceSegment } from './evidence.js';

const segments: EvidenceSegment[] = [
  { id: 'seg-1', idx: 0, startMs: 0, endMs: 5000, text: 'We need to finish the website by Thursday.' },
  { id: 'seg-2', idx: 1, startMs: 5000, endMs: 9000, text: 'محمد هيبعت عرض السعر بكرة.' },
  { id: 'seg-3', idx: 2, startMs: 9000, endMs: 12000, text: 'Agreed, Thursday is the final deadline.' },
];

describe('evidence validation (the anti-hallucination gate)', () => {
  it('keeps an item whose citation and quote check out', () => {
    const outcome = validateEvidence(
      [{ evidenceSegmentIds: ['seg-1', 'seg-3'], quote: 'finish the website by Thursday' }],
      segments,
    );
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.dropped).toHaveLength(0);
    expect(outcome.kept[0].startMs).toBe(0);
    expect(outcome.kept[0].endMs).toBe(12000);
  });

  it('drops an item that cites a segment which does not exist', () => {
    const outcome = validateEvidence(
      [{ evidenceSegmentIds: ['seg-1', 'seg-999'], quote: 'finish the website' }],
      segments,
    );
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.dropped[0].reason).toBe('unknown_segment');
    expect(outcome.dropped[0].detail).toContain('seg-999');
  });

  it('drops an item with no evidence at all', () => {
    const outcome = validateEvidence([{ evidenceSegmentIds: [], quote: 'we agreed to acquire a company' }], segments);
    expect(outcome.dropped[0].reason).toBe('no_evidence');
  });

  it('drops a fabricated quote that is not in the cited segments', () => {
    const outcome = validateEvidence(
      [{ evidenceSegmentIds: ['seg-1'], quote: 'we will pay a bonus of fifty thousand dollars' }],
      segments,
    );
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.dropped[0].reason).toBe('quote_not_found');
  });

  it('accepts an Arabic quote with different spelling of the same words', () => {
    // The transcript says "بكرة"; the model quotes with a hamza variant.
    expect(quoteAppearsIn('محمد هيبعت عرض السعر بكرة', [segments[1].text])).toBe(true);
    const outcome = validateEvidence(
      [{ evidenceSegmentIds: ['seg-2'], quote: 'محمد هيبعت عرض السعر' }],
      segments,
    );
    expect(outcome.kept).toHaveLength(1);
  });

  it('tolerates punctuation and case differences but not invented content', () => {
    expect(quoteAppearsIn('Thursday is the FINAL deadline!!!', [segments[2].text])).toBe(true);
    expect(quoteAppearsIn('Friday is the final deadline', [segments[2].text])).toBe(false);
  });

  it('deduplicates repeated citations', () => {
    const outcome = validateEvidence(
      [{ evidenceSegmentIds: ['seg-1', 'seg-1', 'seg-1'], quote: 'website' }],
      segments,
    );
    expect(outcome.kept[0].evidenceSegmentIds).toEqual(['seg-1']);
  });
});
