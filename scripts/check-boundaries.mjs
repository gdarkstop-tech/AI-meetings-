#!/usr/bin/env node
/**
 * Architectural boundary checks (ADR 0002, docs/01-architecture.md §3).
 *
 * These are the invariants that keep the system provider-agnostic and testable.
 * They run in `npm run verify` and in CI, and they fail the build.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

const IO_MODULES = [
  'node:fs', 'fs', 'node:net', 'net', 'node:http', 'http', 'node:https', 'https',
  'node:dns', 'node:child_process', 'child_process', 'node:dgram', 'node:cluster',
  'node:worker_threads', 'pg', 'express', 'ioredis', 'redis',
];

const VENDOR_SDKS = [
  '@anthropic-ai/', 'openai', '@google-cloud/', 'googleapis', '@aws-sdk/', '@azure/',
  '@deepgram/', 'elevenlabs', 'assemblyai', 'nodemailer', '@microsoft/microsoft-graph-client',
];

const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9]{20,}/, label: 'API key literal' },
  { re: /(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'hardcoded credential' },
  { re: /postgres(?:ql)?:\/\/[^\s'"]*:[^\s'"@]+@/i, label: 'database URL with password' },
];

const rules = [
  {
    name: 'core-and-policy-have-no-io',
    dirs: ['packages/core/src', 'packages/policy/src'],
    check: (file, source) => {
      const bad = [];
      for (const mod of IO_MODULES) {
        const re = new RegExp(`from ['"]${mod.replace('/', '\\/')}['"]`);
        if (re.test(source)) bad.push(`imports I/O module "${mod}"`);
      }
      return bad;
    },
  },
  {
    name: 'vendor-sdks-only-in-providers',
    dirs: ['packages', 'apps'],
    skip: (file) => file.includes(`packages${path.sep}providers${path.sep}`),
    check: (file, source) => {
      const bad = [];
      for (const sdk of VENDOR_SDKS) {
        if (new RegExp(`from ['"]${sdk.replace(/[/@-]/g, (c) => '\\' + c)}`).test(source)) {
          bad.push(`imports vendor SDK "${sdk}" outside packages/providers`);
        }
      }
      return bad;
    },
  },
  {
    name: 'sql-only-in-db-package',
    dirs: ['packages', 'apps'],
    skip: (file) => file.includes(`packages${path.sep}db${path.sep}`),
    check: (file, source) => {
      const bad = [];
      if (/\.query\s*\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(source)) {
        bad.push('issues SQL outside packages/db (use a repository function)');
      }
      return bad;
    },
  },
  {
    name: 'no-hardcoded-secrets',
    dirs: ['packages', 'apps', 'scripts'],
    check: (file, source) => {
      const bad = [];
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(source)) bad.push(`possible ${label}`);
      }
      return bad;
    },
  },
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const violations = [];
for (const rule of rules) {
  for (const dir of rule.dirs) {
    for await (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (/\.(test|spec)\.ts$/.test(rel)) continue; // test fixtures are not production secrets
      if (rule.skip?.(rel)) continue;
      const source = await readFile(file, 'utf8');
      for (const message of rule.check(rel, source)) {
        violations.push(`${rel}: [${rule.name}] ${message}`);
      }
    }
  }
}

if (violations.length) {
  console.error('Architecture boundary violations:\n' + violations.map((v) => `  - ${v}`).join('\n'));
  process.exit(1);
}
console.log('boundaries ok: core/policy are I/O-free, vendor SDKs confined to providers, SQL confined to db, no hardcoded secrets');
