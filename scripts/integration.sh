#!/usr/bin/env bash
# Isolated RPC integration. No live Herdr session or user pane is mutated.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=${BIN:-$ROOT/bin}
for command in jq mktemp; do
  command -v "$command" >/dev/null || { echo "integration requires $command" >&2; exit 1; }
done
test -x "$BIN/woof" && test -x "$BIN/woofd" || { echo "run make build first" >&2; exit 1; }

WORK=$(mktemp -d /tmp/woof-it.XXXXXX)
WORK=$(cd "$WORK" && pwd -P)
export WOOF_STATE_DIR=$WORK/state
export WOOF_CONFIG=$WORK/config.yml
export WOOF_DAEMON_BIN=$BIN/woofd
unset WOOF_SESSION_ID WOOF_WORKSPACE_ID WOOF_WORKTREE_ID WOOF_RUN_ID WOOF_WORKER_ID WOOF_ATTACHMENT_ID
unset HERDR_SOCKET_PATH HERDR_SESSION HERDR_PANE_ID HERDR_WORKSPACE_ID HERDR_TAB_ID
cp "$ROOT/config.example.yml" "$WOOF_CONFIG"

woof() { "$BIN/woof" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  set +e
  if test -n "${FOLLOW:-}"; then kill -TERM "$FOLLOW" 2>/dev/null; wait "$FOLLOW" 2>/dev/null; fi
  if test -n "${WAITER:-}"; then kill -TERM "$WAITER" 2>/dev/null; wait "$WAITER" 2>/dev/null; fi
  woof daemon stop --json >/dev/null 2>&1
  # A stop acknowledgment precedes drain. Do not remove SQLite until it finishes.
  for _ in $(seq 100); do
    test -S "$WOOF_STATE_DIR/woof.sock" || break
    sleep 0.05
  done
  if test -S "$WOOF_STATE_DIR/woof.sock"; then
    echo "daemon did not drain; preserving integration evidence in $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

woof status --global --json >"$WORK/status-a.json" &
A=$!
woof status --global --json >"$WORK/status-b.json" &
B=$!
wait "$A"
wait "$B"
DB_A=$(jq -r '.database' "$WORK/status-a.json")
DB_B=$(jq -r '.database' "$WORK/status-b.json")
test "$DB_A" = "$WOOF_STATE_DIR/woof.db" && test "$DB_A" = "$DB_B" || fail "bootstrap selected different databases"
OLD_PID=$(cat "$WOOF_STATE_DIR/woof.lock")
kill -0 "$OLD_PID" || fail "daemon PID is absent"
if "$BIN/woofd" >"$WORK/second-daemon.log" 2>&1; then
  fail "second long-lived daemon acquired the database"
fi
echo "PASS: concurrent bootstrap shares one daemon/database; second writer refused"

woof profile roster --global --json >"$WORK/roster.json"
jq -e 'length == 3 and all(.[]; has("args") | not)' "$WORK/roster.json" >/dev/null || fail "profile roster leaked argv"
GATE=$(woof gate create --global --question 'Ship the test change?' --options yes,no --json | jq -r '.id')
woof gate resolve "$GATE" --global --decision yes --json >"$WORK/gate.json"
jq -e '.status == "resolved" and .decision == "yes"' "$WORK/gate.json" >/dev/null || fail "gate did not resolve"

"$BIN/woof" events follow --global --since 0 --json >"$WORK/follow.ndjson" 2>"$WORK/follow.stderr" &
FOLLOW=$!
HEAD=$(woof status --global --json | jq -r '.event_cursor')
"$BIN/woof" wait --global --events gate.created --since "$HEAD" --timeout 5s --json >"$WORK/wait.json" &
WAITER=$!
woof gate create --global --question 'Another decision?' --options continue,hold --json >"$WORK/second-gate.json"
wait "$WAITER"
jq -e '.type == "gate.created"' "$WORK/wait.json" >/dev/null || fail "wait missed committed gate event"
for _ in $(seq 100); do
  if test -s "$WORK/follow.ndjson" && jq -e -s 'any(.[]; .type == "gate.created")' "$WORK/follow.ndjson" >/dev/null; then break; fi
  sleep 0.05
done
jq -e -s 'any(.[]; .type == "gate.created")' "$WORK/follow.ndjson" >/dev/null || fail "follow lost replay"
echo "PASS: durable gates, event replay/follow and event-driven wait"

woof ask --global --to human --question 'Which database?' --no-wait --json >"$WORK/question.json"
QUESTION=$(jq -r '.message.id' "$WORK/question.json")
woof reply --global --id "$QUESTION" --body SQLite --json >"$WORK/reply.json"
woof question wait --global --id "$QUESTION" --timeout 3s --json >"$WORK/answer.json"
jq -e '.body == "SQLite"' "$WORK/answer.json" >/dev/null || fail "durable reply was lost"
woof ack --global --id "$QUESTION" --json >/dev/null
woof inbox --global --all --json | jq -e --arg id "$QUESTION" 'any(.[]; .message.id == $id and .delivery.status == "acknowledged")' >/dev/null || fail "ack state missing"
woof consume --global --id "$QUESTION" --json >/dev/null
woof inbox --global --json | jq -e --arg id "$QUESTION" 'all(.[]; .message.id != $id)' >/dev/null || fail "consume did not hide handled delivery"

MESSAGE=$(woof send --global --to human --body 'Review attached handoff.' --artifact "$WORK/missing-handoff.md" --json | jq -r '.message.id')
woof inbox --global --json | jq -e --arg id "$MESSAGE" 'any(.[]; .message.id == $id and .artifacts[0].exists == false)' >/dev/null || fail "missing artifact status was hidden"
echo "PASS: ask/reply, explicit acknowledgment/consumption and artifact status"

HEAD=$(woof status --global --json | jq -r '.event_cursor')
woof daemon restart --json >"$WORK/restarted.json"
NEW_PID=$(cat "$WOOF_STATE_DIR/woof.lock")
test "$OLD_PID" != "$NEW_PID" || fail "daemon did not restart"
woof gate show "$GATE" --global --json | jq -e '.decision == "yes"' >/dev/null || fail "gate lost across restart"
woof question wait --global --id "$QUESTION" --timeout 3s --json | jq -e '.body == "SQLite"' >/dev/null || fail "reply lost across restart"
woof events list --global --since 0 --json | jq -e --argjson head "$HEAD" 'length > 0 and .[-1].seq >= $head' >/dev/null || fail "event replay cursor reset"
woof gate create --global --question 'Observe after restart?' --options yes,no --json >"$WORK/after-restart.json"
for _ in $(seq 100); do
  if jq -e -s --argjson head "$HEAD" 'any(.[]; .type == "gate.created" and .seq > $head)' "$WORK/follow.ndjson" >/dev/null; then break; fi
  sleep 0.05
done
jq -e -s --argjson head "$HEAD" 'any(.[]; .type == "gate.created" and .seq > $head)' "$WORK/follow.ndjson" >/dev/null || fail "active follower lost events across daemon restart"
kill -TERM "$FOLLOW"
wait "$FOLLOW"
FOLLOW=
echo "PASS: daemon drain/restart preserves records, replies, replay cursor and active follower"

# Scheduler surface without live Herdr: workers cannot exist here, so firing is
# covered by daemon tests. This checks scoped reads, refusals and JSON shapes.
woof schedule list --global --json | jq -e 'type == "array" and length == 0' >/dev/null || fail "schedule list is not an empty array"
if woof schedule add --global --name nightly --to alice --cron '0 2 * * *' --body hi --json >"$WORK/sched-noscope.json" 2>&1; then
  fail "schedule without session/workspace scope was accepted"
fi
jq -e '.error.code == "scope_required"' "$WORK/sched-noscope.json" >/dev/null || fail "schedule scope refusal missing: $(cat "$WORK/sched-noscope.json")"
set +e
woof schedule add --global --name nightly --to alice --cron '0 2 * * *' --every 1h --body hi --json >"$WORK/sched-both.json" 2>&1
STATUS=$?
set -e
test "$STATUS" = 2 || fail "conflicting --cron/--every was not a usage error ($STATUS)"
if woof schedule show sched_missing --global --json >"$WORK/sched-missing.json" 2>&1; then
  fail "missing schedule was shown"
fi
jq -e '.error.code == "not_found"' "$WORK/sched-missing.json" >/dev/null || fail "missing schedule code: $(cat "$WORK/sched-missing.json")"
if woof schedule run sched_missing --global --json >"$WORK/sched-run-missing.json" 2>&1; then
  fail "missing schedule ran"
fi
jq -e '.error.code == "not_found"' "$WORK/sched-run-missing.json" >/dev/null || fail "missing schedule run code"
woof operation list --global --json | jq -e 'any(.[]; .op == "schedule.run" and .state == "failed" and .error_code == "not_found")' >/dev/null || fail "refused schedule mutation lacks a final receipt"
echo "PASS: scheduler reads, scope refusal, usage errors and final receipts"

# Optional read/attach verification against sockets the operator explicitly selects.
# It never creates/stops Herdr sessions or touches panes/workspaces.
if test -n "${WOOF_IT_HERDR_SOCKETS:-}"; then
  COUNT=0
  while IFS= read -r socket; do
    test -n "$socket" || continue
    woof session attach --global --socket "$socket" --json >/dev/null
    COUNT=$((COUNT+1))
  done <<<"$WOOF_IT_HERDR_SOCKETS"
  woof session list --global --json | jq -e --argjson count "$COUNT" 'length >= $count' >/dev/null || fail "selected sessions missing"
  test "$NEW_PID" = "$(cat "$WOOF_STATE_DIR/woof.lock")" || fail "session attach replaced daemon"
  echo "PASS: explicitly selected live sessions attach to the existing daemon"
fi

echo "All isolated Woof RPC integration scenarios passed."
