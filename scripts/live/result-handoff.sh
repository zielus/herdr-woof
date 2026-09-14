#!/usr/bin/env bash
# Live Herdr acceptance check for the p1 result handoff.
#
# A real Claude Code worker in a sibling Herdr pane writes a review artifact and
# submits it with bin/woof submit. The script proves the handoff from the run
# journal, never from terminal output. It is not part of `bun run verify`.
#
#   scripts/live/result-handoff.sh --probe   # short check: can the worker write and submit unattended?
#   bash scripts/live/result-handoff.sh 2>&1 | tee docs/research/result-handoff-live.log
#
# The worker starts with --permission-mode auto --add-dir "$RUN_DIR". No bypass
# mode, no allowlist, and nothing is auto-approved.
#
# Exit codes: 0 all hard gates passed; 1 a precondition or hard gate failed;
# 4 the worker blocked (for example on a permission prompt).
#
# Environment: WOOF_LIVE_ROOT overrides the parent of the run directory;
# WOOF_LIVE_KEEP_PANE=1 leaves the worker pane open for inspection.
set -euo pipefail

mode=run
case "${1:-}" in
  "") ;;
  --probe) mode=probe ;;
  *)
    echo "usage: $0 [--probe]" >&2
    exit 1
    ;;
esac

WT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WT"

if [ "${HERDR_ENV:-}" != 1 ]; then
  echo "FAIL: run this inside Herdr (HERDR_ENV=1)" >&2
  exit 1
fi
for tool in herdr claude node bun jq shasum grep git; do
  command -v "$tool" >/dev/null || {
    echo "FAIL: $tool is not on PATH" >&2
    exit 1
  }
done

STAMP="$(date +%Y%m%d-%H%M%S)"
LIVE_ROOT="${WOOF_LIVE_ROOT:-$HOME/.herdr-dev/runs/herdr-woof/p1-result-handoff/live}"
if [ "$mode" = probe ]; then
  RUN_ID="live-probe-$STAMP"
  AGENT="handoff-probe-$STAMP"
  STAGE=probe
  VERDICTS=""
else
  RUN_ID="live-handoff-$STAMP"
  AGENT="handoff-worker-$STAMP" # agent names must be unique in the Herdr server
  STAGE=report
  VERDICTS="pass,fail"
fi
RUN_DIR="$LIVE_ROOT/$RUN_ID"
J="$RUN_DIR/journal.jsonl"
PANE=""
failures=0

section() { printf '\n== %s\n' "$*"; }
pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}
warn() { echo "WARN: $*"; }
gate() {
  local description="$1"
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

# On a failed exit, print the worker pane before closing it so the evidence
# survives in the log.
close_pane() {
  local status=$?
  if [ -n "$PANE" ] && [ "${WOOF_LIVE_KEEP_PANE:-0}" != 1 ]; then
    if [ "$status" -ne 0 ]; then
      printf '\n== worker pane before close (exit %s)\n' "$status"
      herdr pane read "$PANE" --source recent-unwrapped --lines 80 2>&1 || true
    fi
    herdr pane close "$PANE" >/dev/null 2>&1 || echo "WARN: could not close pane $PANE"
  fi
}
trap close_pane EXIT

# Number of journal records of a type; 0 while the journal is absent or mid-write.
count() {
  local n
  n="$(jq -s --arg t "$1" 'map(select(.type == $t)) | length' "$J" 2>/dev/null)" || n=0
  echo "${n:-0}"
}

agent_status() {
  local raw status
  raw="$(herdr agent get "$AGENT" 2>&1 || true)"
  status="$(printf '%s' "$raw" | jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)"
  if [ -z "$status" ]; then
    echo "WARN: unexpected herdr agent get response: $raw" >&2
    echo unknown
  else
    echo "$status"
  fi
}

read_worker() {
  herdr agent read "$AGENT" --source recent-unwrapped --lines "${1:-80}" || true
}

stop_if_blocked() {
  if [ "$(agent_status)" = blocked ]; then
    section "worker blocked"
    read_worker 80
    echo "BLOCKED: the worker is waiting for approval. Stopping; nothing is auto-approved."
    exit 4
  fi
}

sha_of() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

section "environment"
echo "mode: $mode"
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "commit: $(git rev-parse HEAD)"
echo "herdr: $(herdr --version 2>&1)"
echo "claude: $(claude --version 2>&1)"
echo "node: $(node --version)"
echo "bun: $(bun --version)"
echo "run id: $RUN_ID"
echo "run dir: $RUN_DIR"
echo "agent: $AGENT"
echo "verifier pane: ${HERDR_PANE_ID:-unset}"
bun run build >/dev/null
echo "build: ok"
git_before="$(git status --porcelain)"
mkdir -p "$RUN_DIR"

section "worker pane"
split="$(herdr pane split --current --direction down --cwd "$WT" --no-focus --env "WOOF_RUN_DIR=$RUN_DIR")"
PANE="$(printf '%s' "$split" | jq -r '.result.pane.pane_id // empty' 2>/dev/null || true)"
if [ -z "$PANE" ]; then
  echo "FAIL: herdr pane split returned no pane id: $split"
  exit 1
fi
echo "worker pane: $PANE"

section "attempt"
bin/woof attempt open --run-dir "$RUN_DIR" --run "$RUN_ID" --agent "$AGENT" \
  --stage "$STAGE" --visit 1 --attempt 1 --verdicts "$VERDICTS" --pane "$PANE"

section "worker agent"
# Startup can stop at an approval or question and still leave the named agent
# in the pane, so a failed start is classified rather than exiting blindly.
set +e
start_output="$(herdr agent start "$AGENT" --kind claude --pane "$PANE" --timeout 60000 -- \
  --permission-mode auto --add-dir "$RUN_DIR" 2>&1)"
start_exit=$?
set -e
echo "$start_output"
if [ "$start_exit" -ne 0 ]; then
  if [ "$(agent_status)" = blocked ]; then
    section "worker blocked during startup"
    read_worker 80
    echo "BLOCKED: the worker is waiting for approval. Stopping; nothing is auto-approved."
    exit 4
  fi
  section "worker failed to start"
  read_worker 80
  echo "FAIL: herdr agent start exited $start_exit: $start_output"
  exit 1
fi

if [ "$mode" = probe ]; then
  PROBE_FILE="$RUN_DIR/artifacts/probe/visit-1/attempt-1/probe.md"
  PROMPT="$(
    cat <<EOF
You are a Woof live-check probe for run $RUN_ID. Do exactly these three things and nothing else:

1. Run: bin/woof --version
2. Write the single line "probe ok" to $PROBE_FILE
3. Run: bin/woof submit --envelope $RUN_DIR/outbox/absent.json

The third command is expected to print a rejection; that is correct. Do not modify any repository file.
EOF
  )"
  herdr agent prompt "$AGENT" "$PROMPT" >/dev/null

  section "waiting for the probe (journal and run directory are the only proof)"
  done_probe=0
  for _ in $(seq 1 36); do # <= 3 min at 5 s
    if [ -f "$PROBE_FILE" ] && [ "$(count submission.rejected)" -ge 1 ]; then
      done_probe=1
      break
    fi
    stop_if_blocked
    sleep 5
  done
  if [ "$done_probe" != 1 ]; then
    read_worker 80
    echo "FAIL: probe did not finish within 3 minutes"
    exit 1
  fi

  gate "worker wrote into the run directory" grep -q '^probe ok' "$PROBE_FILE"
  REJ="$(jq -c -s 'map(select(.type == "submission.rejected"))[0]' "$J")"
  echo "$REJ"
  probe_submit_ran() {
    printf '%s' "$REJ" | jq -e --arg p "$PANE" '.reason == "envelope_malformed" and .paneId == $p' >/dev/null
  }
  gate "worker ran bin/woof submit from its pane" probe_submit_ran
  git_after="$(git status --porcelain)"
  gate "repository tree unchanged by the worker" [ "$git_before" = "$git_after" ]
  section "journal"
  cat "$J"
  section "worker pane (recent)"
  read_worker 60
  section "result"
  if [ "$failures" -gt 0 ]; then
    echo "PROBE FAILED: $failures gate(s)"
    exit 1
  fi
  echo "PROBE OK"
  exit 0
fi

ARTIFACT_REL="artifacts/report/visit-1/attempt-1/report.md"
PROMPT="$(
  cat <<EOF
You are worker $AGENT for Woof run $RUN_ID, stage "report", visit 1, attempt 1. The run directory is $RUN_DIR. Do this and nothing else:

1. Read src/contracts/reasons.ts and src/submission/submit.ts in this repository.
2. Write a Markdown artifact to $RUN_DIR/$ARTIFACT_REL. Title it "# Rejection-order review" and give it one "## <reason_code>" section for every code in REJECTION_REASONS. Each section states the condition that triggers the code and the src/submission/submit.ts:<line> where it is checked. End with a "## Verdict" section stating pass if the implementation order matches the order in the doc comment of submitResult, otherwise fail with the discrepancy.
3. Compute its hash: shasum -a 256 $RUN_DIR/$ARTIFACT_REL
4. Write $RUN_DIR/outbox/envelope.json containing one JSON object with schemaVersion 1, runId "$RUN_ID", agentId "$AGENT", stageId "report", visit 1, attempt 1, status "completed", verdict set to your verdict ("pass" or "fail"), and artifact {"path": "$ARTIFACT_REL", "sha256": "<the hash>"}.
5. Run bin/woof submit --envelope $RUN_DIR/outbox/envelope.json and show its JSON output. If it is rejected, fix only what the reason names and submit again, at most 3 times.
6. Run the exact same submit command once more and show its output.

Do not modify any repository file.
EOF
)"
# --wait does not track turns and may match an earlier completion; the journal
# poll below is the proof. The prompt is never re-sent.
herdr agent prompt "$AGENT" "$PROMPT" --wait --until idle --until done --until blocked \
  --timeout 900000 || true

section "waiting for acceptance (the journal is the only proof)"
accepted=0
for _ in $(seq 1 180); do # <= 15 min at 5 s
  if [ "$(count submission.accepted)" -ge 1 ]; then
    accepted=1
    break
  fi
  stop_if_blocked
  sleep 5
done
if [ "$accepted" != 1 ]; then
  read_worker 120
  echo "FAIL: no submission.accepted within 15 minutes"
  exit 1
fi

section "waiting for the worker's identical resubmission"
for _ in $(seq 1 24); do # <= 2 min at 5 s
  [ "$(count submission.duplicate)" -ge 1 ] && break
  stop_if_blocked
  sleep 5
done

section "hard gates"
gate "exactly one submission.accepted" [ "$(count submission.accepted)" -eq 1 ]
ACC="$(jq -c -s 'map(select(.type == "submission.accepted"))[0]' "$J")"
echo "$ACC"
identity_matches() {
  printf '%s' "$ACC" | jq -e --arg a "$AGENT" --arg r "$RUN_ID" --arg p "$PANE" \
    '.agentId == $a and .runId == $r and .stageId == "report" and .visit == 1 and .attempt == 1 and .paneId == $p' \
    >/dev/null
}
gate "accepted identity and pane match the attempt" identity_matches
H="$(printf '%s' "$ACC" | jq -r .artifact.sha256)"
ORIGINAL="$RUN_DIR/$(printf '%s' "$ACC" | jq -r .artifact.path)"
A="$RUN_DIR/$(printf '%s' "$ACC" | jq -r .artifact.acceptedPath)"
gate "worker artifact sha256 equals the accepted record" [ "$(sha_of "$ORIGINAL")" = "$H" ]
gate "accepted copy sha256 equals the accepted record" [ "$(sha_of "$A")" = "$H" ]

words="$(wc -w <"$A" | tr -d ' ')"
# grep -c prints 0 and exits 1 when nothing matches.
sections="$(grep -c '^## ' "$A" || true)"
sections="${sections:-0}"
refs="$(grep -cE 'src/submission/submit\.ts:[0-9]+' "$A" || true)"
refs="${refs:-0}"
gate "artifact title present" grep -q '^# Rejection-order review' "$A"
gate "artifact verdict section present" grep -q '^## Verdict' "$A"
gate "artifact has at least 250 words ($words)" [ "$words" -ge 250 ]
gate "artifact has at least 5 sections ($sections)" [ "$sections" -ge 5 ]
gate "artifact has at least 5 submit.ts:line references ($refs)" [ "$refs" -ge 5 ]

git_after="$(git status --porcelain)"
if [ "$git_before" = "$git_after" ]; then
  pass "repository tree unchanged by the worker"
else
  fail "repository tree changed during the run"
  diff <(printf '%s\n' "$git_before") <(printf '%s\n' "$git_after") || true
fi

section "negative probe from the verifier pane"
if [ -z "${HERDR_PANE_ID:-}" ] || [ "$HERDR_PANE_ID" = "$PANE" ]; then
  fail "verifier HERDR_PANE_ID must be set and differ from the worker pane $PANE"
else
  set +e
  negative="$(bin/woof submit --run-dir "$RUN_DIR" --envelope "$RUN_DIR/outbox/envelope.json")"
  negative_exit=$?
  set -e
  echo "$negative"
  echo "exit=$negative_exit"
  owner_mismatch_on_pane() {
    printf '%s' "$negative" |
      jq -e '.outcome == "rejected" and .reason == "owner_mismatch" and ([.details[].field] | index("paneId") != null)' \
        >/dev/null
  }
  gate "negative probe exits 2" [ "$negative_exit" -eq 2 ]
  gate "negative probe is owner_mismatch naming paneId" owner_mismatch_on_pane
  gate "still exactly one submission.accepted" [ "$(count submission.accepted)" -eq 1 ]
fi

section "warnings (logged, not gates)"
codes="$(node --input-type=module -e "import('$WT/dist/index.js').then((m) => console.log(m.REJECTION_REASONS.join(' ')))")"
for code in $codes; do
  grep -qE "^## \`?${code}([^A-Za-z0-9_]|\$)" "$A" || warn "no section for $code"
done
duplicates="$(count submission.duplicate)"
[ "$duplicates" -ge 1 ] || warn "no submission.duplicate from the worker's repeated submit"
echo "submission.duplicate records: $duplicates"
echo "submission.rejected records: $(count submission.rejected)"

section "journal"
cat "$J"
section "accepted artifact ($A)"
cat "$A"
section "worker pane (recent)"
read_worker 120

section "human inspection"
echo "REQUIRED: the verifier reads the accepted artifact above, confirms that its"
echo "src/submission/submit.ts:<line> references point at the real checks, and records"
echo "that result in this log."

section "result"
if [ "$failures" -gt 0 ]; then
  echo "FAILED: $failures hard gate(s)"
  exit 1
fi
echo "ALL HARD GATES PASSED"
