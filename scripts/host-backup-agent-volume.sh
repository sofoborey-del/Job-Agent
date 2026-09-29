#!/usr/bin/env bash
# Daily backup of the hosted discovery agent's data volume.
#
# PGlite must not be copied while it is open, so this stops the container, copies the volume, and
# starts it again. The gap is a few seconds against a 15 minute discovery cadence.
#
# The archive holds the AES-256-GCM encrypted profile and artifacts. It is unreadable without
# APP_ENCRYPTION_KEY_BASE64, which is deliberately not stored here or anywhere on this host outside
# the owner-only .env.hosted.
set -euo pipefail

COMPOSE_DIR=/home/opc/job-agent
COMPOSE_FILE=compose.discovery.yml
VOLUME=job-application-agent-data
BACKUP_DIR=/home/opc/backups
KEEP_DAYS=7

umask 077
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%d-%H%M%SZ)
name="agent-data-$stamp.tgz"
archive="$BACKUP_DIR/$name"

cd "$COMPOSE_DIR"
docker compose -f "$COMPOSE_FILE" stop >/dev/null
trap 'docker compose -f "$COMPOSE_FILE" start >/dev/null || true' EXIT

# Two things this needs. The backup directory belongs to root because the timer runs as root, and
# the image's default user is the unprivileged 'node', so tar runs as root here. SELinux is
# enforcing on this host, so the bind mount also needs a relabel (:z) to be writable at all.
docker run --rm --user 0:0 -v "$VOLUME":/data:ro -v "$BACKUP_DIR":/backup:z \
  --entrypoint tar job-agent-agent:latest -czf "/backup/$name" -C /data .

docker compose -f "$COMPOSE_FILE" start >/dev/null
trap - EXIT

chown "$(stat -c %u "$BACKUP_DIR")":"$(stat -c %g "$BACKUP_DIR")" "$archive"
chmod 600 "$archive"
find "$BACKUP_DIR" -name 'agent-data-*.tgz' -type f -mtime +"$KEEP_DAYS" -delete
echo "backed up to $archive ($(stat -c %s "$archive") bytes); keeping $KEEP_DAYS days"
