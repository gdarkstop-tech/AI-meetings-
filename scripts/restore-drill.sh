#!/usr/bin/env bash
# Restore drill: a backup you have never restored is not a backup.
# Restores the newest dump into a scratch database and checks it is usable.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
SCRATCH_DB="${SCRATCH_DB:-alia_restore_drill}"

DUMP="$(ls -1t "${BACKUP_DIR}"/alia-*.dump 2>/dev/null | head -n1 || true)"
[ -n "${DUMP}" ] || { echo "[drill] no dump found in ${BACKUP_DIR}" >&2; exit 1; }
echo "[drill] restoring ${DUMP} into ${SCRATCH_DB}"

ADMIN_URL="${DATABASE_URL%/*}/postgres"
psql "${ADMIN_URL}" -q -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};"
psql "${ADMIN_URL}" -q -c "CREATE DATABASE ${SCRATCH_DB};"

RESTORE_URL="${DATABASE_URL%/*}/${SCRATCH_DB}"
pg_restore --no-owner --no-acl --dbname="${RESTORE_URL}" "${DUMP}"

echo "[drill] verifying"
psql "${RESTORE_URL}" -t -c "SELECT 'workspaces=' || count(*) FROM workspaces;"
psql "${RESTORE_URL}" -t -c "SELECT 'meetings=' || count(*) FROM meetings;"
psql "${RESTORE_URL}" -t -c "SELECT 'audit_rows=' || count(*) FROM audit_log;"
psql "${RESTORE_URL}" -t -c "SELECT 'extensions=' || string_agg(extname, ',') FROM pg_extension WHERE extname IN ('vector','pg_trgm','unaccent');"

echo "[drill] ok — dropping scratch database"
psql "${ADMIN_URL}" -q -c "DROP DATABASE ${SCRATCH_DB};"
