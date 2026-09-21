import { z } from 'zod';

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);

/** Language of the spoken content of a meeting (Phase 2+ uses this). */
export const MEETING_LANGUAGES = ['ar', 'en', 'mixed'] as const;
export type MeetingLanguage = (typeof MEETING_LANGUAGES)[number];

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(200);
export const displayNameSchema = z.string().trim().min(1).max(120);

/**
 * The authorization scope every repository call requires.
 * There is deliberately no repository method that can read without one.
 */
export interface Scope {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface ActorRef {
  type: 'user' | 'ai' | 'system';
  id: string | null;
}
