import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeForSearch, type Scope } from '@alia/core';
import {
  addMember,
  createMeeting,
  createTranscriptVersion,
  createUser,
  createWorkspace,
  insertSegments,
  lexicalSearch,
  segmentLexicalSearch,
  withTransaction,
  type Pool,
} from './index.js';
import { hasTestDatabase, setupTestDatabase, uniqueEmail } from '../../../test/support/db.js';

const d = hasTestDatabase ? describe : describe.skip;

/** Real Arabic/English search over real rows in PostgreSQL. */
d('workspace search', () => {
  let pool: Pool;
  let scope: Scope;
  let otherScope: Scope;
  let meetingId: string;

  const lines = [
    'نحتاج إنهاء الموقع يوم الخميس القادم',
    'محمد هيبعت عرض السعر بكرة الصبح',
    'We agreed the website deadline is Thursday',
    'مُحَمَّد قال إن الميزانية ٢٠٢٦ كافية',
  ];

  const seedWorkspace = async (name: string) => {
    return withTransaction(pool, async (client) => {
      const user = await createUser(client, {
        email: uniqueEmail('search'),
        name: 'Search Tester',
        passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      });
      const workspace = await createWorkspace(client, { name });
      await addMember(client, { workspaceId: workspace.id, userId: user.id, role: 'owner' });
      return { workspaceId: workspace.id, userId: user.id, role: 'owner' as const };
    });
  };

  beforeAll(async () => {
    pool = await setupTestDatabase();
    scope = await seedWorkspace('Search workspace');
    otherScope = await seedWorkspace('Other workspace');

    await withTransaction(pool, async (client) => {
      const meeting = await createMeeting(client, scope, {
        title: 'اجتماع الموقع',
        titleNormalized: normalizeForSearch('اجتماع الموقع'),
        language: 'mixed',
        source: 'upload',
        consent: { obtained: true, method: 'verbal' },
        retentionExpiresAt: null,
      });
      meetingId = meeting.id;
      const version = await createTranscriptVersion(client, {
        workspaceId: scope.workspaceId,
        meetingId: meeting.id,
        providerId: 'test-fixture',
        modelVersion: 'fixture-1',
        languageHint: 'mixed',
      });
      await insertSegments(client, {
        workspaceId: scope.workspaceId,
        meetingId: meeting.id,
        versionId: version.id,
        segments: lines.map((text, idx) => ({
          idx,
          startMs: idx * 5000,
          endMs: idx * 5000 + 4000,
          speaker: `Speaker ${(idx % 2) + 1}`,
          text,
          textNormalized: normalizeForSearch(text),
        })),
      });
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('finds an Arabic phrase written with a tatweel (the Phase 0 defect)', async () => {
    const hits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('الموقـع') });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.snippet.includes('الموقع'))).toBe(true);
  });

  it('finds the same word spelled with and without diacritics', async () => {
    const withDiacritics = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('مُحَمَّد') });
    const without = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('محمد') });
    expect(withDiacritics.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    expect(withDiacritics[0].id).toBe(without[0].id);
  });

  it('matches Arabic-Indic and ASCII digits interchangeably', async () => {
    const arabicDigits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('٢٠٢٦') });
    const asciiDigits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('2026') });
    expect(arabicDigits.length).toBeGreaterThan(0);
    expect(asciiDigits.length).toBeGreaterThan(0);
  });

  it('searches English content in the same index', async () => {
    const hits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('website deadline') });
    expect(hits.some((h) => h.snippet.includes('website deadline'))).toBe(true);
  });

  it('returns meetings and segments, each with a jump point', async () => {
    const hits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('الموقع') });
    const segment = hits.find((h) => h.type === 'segment');
    expect(segment?.meeting_id).toBe(meetingId);
    expect(typeof segment?.start_ms).toBe('number');
  });

  it('never returns another workspace\'s content', async () => {
    const hits = await lexicalSearch(pool, otherScope, { normalizedQuery: normalizeForSearch('الموقع') });
    expect(hits).toHaveLength(0);
    const ragHits = await segmentLexicalSearch(pool, otherScope, { normalizedQuery: normalizeForSearch('website') });
    expect(ragHits).toHaveLength(0);
  });

  it('returns nothing for a term that was never said, rather than a loose match', async () => {
    const hits = await lexicalSearch(pool, scope, { normalizedQuery: normalizeForSearch('cryptocurrency acquisition') });
    expect(hits).toHaveLength(0);
  });
});
