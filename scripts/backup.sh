#!/usr/bin/env bash
# Database backup. Run from cron; verify with scripts/restore-drill.sh.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/alia-${STAMP}.dump"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

mkdir -p "${BACKUP_DIR}"
echo "[backup] dumping to ${TARGET}"
pg_dump --format=custom --no-owner --no-acl --file="${TARGET}" "${DATABASE_URL}"

SIZE="$(stat -c%s "${TARGET}")"
if [ "${SIZE}" -lt 1000 ]; then
  echo "[backup] FAILED: dump is only ${SIZE} bytes" >&2
  exit 1
fi
echo "[backup] ok: ${SIZE} bytes"

find "${BACKUP_DIR}" -name 'alia-*.dump' -mtime "+${RETAIN_DAYS}" -delete
echo "[backup] pruned dumps older than ${RETAIN_DAYS} days"

# Media lives in object storage; back it up with the provider's own tooling
# (S3 versioning / lifecycle rules, or rsync for the local adapter).
