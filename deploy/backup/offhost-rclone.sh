#!/bin/sh
# Off-host copy hook (BACKUP_OFFHOST_COMMAND) using rclone — S3-compatible object storage, Azure Blob, GCS, SFTP, …
# Called as: offhost-rclone.sh <set directory> <set id>
# Required environment: OFFHOST_RCLONE_REMOTE=hrbackup:my-bucket/hr     (an rclone remote configured by the operator)
# Credentials live in rclone's own configuration / environment (RCLONE_CONFIG_* variables) — never in this repository.
set -eu
SET_DIR="$1"; SET_ID="$2"
: "${OFFHOST_RCLONE_REMOTE:?OFFHOST_RCLONE_REMOTE is required}"
rclone copy --checksum --no-traverse "$SET_DIR" "$OFFHOST_RCLONE_REMOTE/$SET_ID"
