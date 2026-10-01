#!/bin/sh
# Verification hook (BACKUP_OFFHOST_VERIFY_COMMAND) for offhost-rclone.sh: every local file must exist remotely with the
# same size and hash (rclone check compares provider hashes; --download compares bytes where no hash is offered).
set -eu
SET_DIR="$1"; SET_ID="$2"
: "${OFFHOST_RCLONE_REMOTE:?}"
rclone check --one-way ${OFFHOST_RCLONE_DOWNLOAD:+--download} "$SET_DIR" "$OFFHOST_RCLONE_REMOTE/$SET_ID"
