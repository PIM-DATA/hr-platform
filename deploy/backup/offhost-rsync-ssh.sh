#!/bin/sh
# Off-host copy hook for `npm run ops:backup` (BACKUP_OFFHOST_COMMAND) — rsync over SSH to ANOTHER host.
# Called as: offhost-rsync-ssh.sh <set directory> <set id>   (no shell expansion of secrets; key-based SSH only)
# Required environment (deployment configuration, not secrets): OFFHOST_SSH_TARGET=backup@backup-host.example
#                                                             OFFHOST_SSH_PATH=/srv/hr-backups
# The SSH private key lives in the service user's ~/.ssh (or set OFFHOST_SSH_KEY to its path); it is never logged.
set -eu
SET_DIR="$1"; SET_ID="$2"
: "${OFFHOST_SSH_TARGET:?OFFHOST_SSH_TARGET is required}"; : "${OFFHOST_SSH_PATH:?OFFHOST_SSH_PATH is required}"
SSH="ssh -o BatchMode=yes ${OFFHOST_SSH_KEY:+-i $OFFHOST_SSH_KEY}"
# Copy into a temporary name, then rename: a half-copied set never carries the final name on the remote either.
# -a preserves the set's owner-only modes (0700 directories, 0600 files)
rsync -a -e "$SSH" "$SET_DIR/" "$OFFHOST_SSH_TARGET:$OFFHOST_SSH_PATH/$SET_ID.partial/"
$SSH "$OFFHOST_SSH_TARGET" "rm -rf '$OFFHOST_SSH_PATH/$SET_ID' && mv '$OFFHOST_SSH_PATH/$SET_ID.partial' '$OFFHOST_SSH_PATH/$SET_ID'"
