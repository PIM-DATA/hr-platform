#!/bin/sh
# Verification hook (BACKUP_OFFHOST_VERIFY_COMMAND) for offhost-rsync-ssh.sh: the REMOTE host re-hashes every file of the
# set against its SHA256SUMS. Exit 0 only when the remote copy is complete and byte-identical.
set -eu
SET_ID="$2"
: "${OFFHOST_SSH_TARGET:?}"; : "${OFFHOST_SSH_PATH:?}"
SSH="ssh -o BatchMode=yes ${OFFHOST_SSH_KEY:+-i $OFFHOST_SSH_KEY}"
$SSH "$OFFHOST_SSH_TARGET" "cd '$OFFHOST_SSH_PATH/$SET_ID' && sha256sum --quiet -c SHA256SUMS"
# The checksum file itself must be the one this run produced.
REMOTE_SUMS=$($SSH "$OFFHOST_SSH_TARGET" "sha256sum '$OFFHOST_SSH_PATH/$SET_ID/SHA256SUMS'" | cut -d' ' -f1)
[ "$REMOTE_SUMS" = "$BACKUP_SHA256SUMS_SHA256" ]
