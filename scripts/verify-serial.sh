#!/bin/sh
# Machine-wide serialization for `bun run verify`: only one full verify run
# holds the lock at a time, so concurrent agents on this machine don't
# saturate it with parallel test suites. See AGENTS.md § Running tests.
set -u

LOCK_DIR=/tmp/woof-verify.lock
STALE_SECONDS=$((45 * 60))
lock_held=0

# Only release the lock if this process is the one holding it: a waiter that
# gets signaled before acquiring the lock must never remove the holder's lock.
cleanup() {
  if [ "$lock_held" -eq 1 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    lock_held=0
  fi
}
trap cleanup EXIT

# INT/TERM must actually stop the script; a bare `trap cleanup INT TERM`
# would run cleanup() and then resume the while loop instead of exiting.
on_signal() {
  trap - EXIT INT TERM
  cleanup
  exit 143
}
trap on_signal INT TERM

printed_waiting=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if [ "$printed_waiting" -eq 0 ]; then
    echo "verify-serial: waiting for lock $LOCK_DIR"
    printed_waiting=1
  fi

  lock_age=0
  if [ -d "$LOCK_DIR" ]; then
    lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "")
    if [ -n "$lock_mtime" ]; then
      now=$(date +%s)
      lock_age=$((now - lock_mtime))
    fi
  fi

  if [ "$lock_age" -gt "$STALE_SECONDS" ]; then
    echo "verify-serial: lock $LOCK_DIR is stale (older than 45 minutes), removing it"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    continue
  fi

  sleep 20
done
lock_held=1

echo "verify-serial: lock $LOCK_DIR acquired"

WOOF_TEST_WORKERS="${WOOF_TEST_WORKERS:-4}"
export WOOF_TEST_WORKERS

# Not `exec`: the EXIT trap above must still run in this process after
# `bun run verify` finishes to release the lock (exec would replace this
# shell, and the trap would never fire).
bun run verify
