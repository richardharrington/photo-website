#!/bin/bash
#
# Nightly mirror of the R2 bucket to encrypted local storage.
#
# Deliberately an exact mirror, not an accumulating archive: items permanently
# deleted or purged from R2 disappear locally on the next run, and IDrive's
# nightly backup provides the historical copy. Because trashed photos' objects
# stay in place in R2, the mirror naturally includes the full 30-day trash
# along with the catalog, its snapshots, and the audit log.
#
# Run before IDrive's nightly schedule; see docs/operations.md.

set -euo pipefail

# --- Configuration ---------------------------------------------------------
# The rclone remote is configured in the user profile with restricted
# permissions, so no credentials appear here or in the launchd plist.
REMOTE="${PHOTO_BACKUP_REMOTE:-r2-photos:family-photos}"
DESTINATION="${PHOTO_BACKUP_DEST:-$HOME/PhotoBackup/family-photos}"
LOG_DIR="${PHOTO_BACKUP_LOG_DIR:-$HOME/Library/Logs/photo-backup}"
LOG_FILE="$LOG_DIR/backup.log"

# A sync that suddenly wants to delete most of the mirror is far more likely to
# be a misconfigured remote or an empty listing than a real mass deletion, so
# refuse rather than destroy the local copy.
MAX_DELETE="${PHOTO_BACKUP_MAX_DELETE:-50}"

mkdir -p "$DESTINATION" "$LOG_DIR"

log() {
  printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"
}

fail() {
  log "FAILED: $*"
  # Fail visibly: a backup that quietly stops working is worse than none,
  # because it is trusted. This surfaces in Notification Center.
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Photo backup failed\"" \
      >/dev/null 2>&1 || true
  fi
  exit 1
}

command -v rclone >/dev/null 2>&1 || fail "rclone is not installed"

log "Starting mirror: $REMOTE -> $DESTINATION"

if ! rclone sync "$REMOTE" "$DESTINATION" \
  --max-delete "$MAX_DELETE" \
  --transfers 4 \
  --checkers 8 \
  --retries 3 \
  --log-file "$LOG_FILE" \
  --log-level INFO \
  --stats-one-line \
  --stats 5m; then
  fail "rclone sync exited non-zero (see $LOG_FILE)"
fi

# A mirror with no catalog is not a usable restore point, whatever else it
# contains, so treat its absence as a failure rather than a warning.
if [ ! -f "$DESTINATION/catalog/current.json" ]; then
  fail "mirror completed but catalog/current.json is missing"
fi

PHOTO_COUNT=$(find "$DESTINATION/photos" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
log "Mirror complete: $PHOTO_COUNT photo directories, catalog present"
