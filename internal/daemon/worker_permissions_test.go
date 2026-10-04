package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/zielus/herdr-woof/internal/cli"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/paths"
	"github.com/zielus/herdr-woof/internal/profiles"
)

const claudeSettings = `{"permissions":{"allow":["Bash(woof inbox *)","Bash(woof message show *)","Bash(woof message ack *)","Bash(woof message consume *)","Bash(woof ack *)","Bash(woof consume *)","Bash(woof reply *)","Bash(woof dispatch show *)","Bash(woof dispatch check *)","Bash(woof done *)","Bash(woof worker show *)","Bash(woof status *)","Bash(woof operation show *)","Bash(woof wait *)","Bash(woof question wait *)","Bash(woof events list *)","Bash(woof events follow *)","Bash(woof send *)","Bash(woof ask *)","Bash(printenv WOOF_WORKER_ID)","Bash(printenv WOOF_ATTACHMENT_ID)"]}}`

func codexGrant(sock string) []string {
	return []string{"--no-daemon", "--enable", "network_proxy",
		"-c", `permissions.woof={extends=":workspace",network={enabled=true,mode="limited",unix_sockets={"` + sock + `"="allow"}}}`,
		"-c", `default_permissions="woof"`}
}

func TestWorkerPermissionArgsPerAgentKind(t *testing.T) {
	const sock = "/Users/someone/.woof/woof.sock"
	if got := workerPermissionArgs("claude", []string{"--model", "haiku"}, sock); !reflect.DeepEqual(got, []string{"--settings", claudeSettings}) {
		t.Fatalf("claude: %#v", got)
	}
	if got := workerPermissionArgs("claude", nil, ""); len(got) != 2 {
		t.Fatalf("claude needs no socket: %#v", got)
	}
	if got := workerPermissionArgs("codex", []string{"--model", "gpt-5.5", "-c", "model_reasoning_effort=high"}, sock); !reflect.DeepEqual(got, codexGrant(sock)) {
		t.Fatalf("codex: %#v", got)
	}
	// A duplicate --no-daemon is not added; the grant still is.
	if got := workerPermissionArgs("codex", []string{"--no-daemon"}, sock); !reflect.DeepEqual(got, codexGrant(sock)[1:]) {
		t.Fatalf("codex with --no-daemon: %#v", got)
	}
	for _, kind := range []string{"omp", "sleep", "gemini", "grok", ""} {
		if got := workerPermissionArgs(kind, nil, sock); got != nil {
			t.Fatalf("%q was given permissions: %#v", kind, got)
		}
	}
	// No socket to grant, or one that would need TOML escaping: nothing at all,
	// never network access without a socket restriction.
	for _, bad := range []string{"", `/tmp/a"b.sock`, `/tmp/a\b.sock`, "/tmp/a\nb.sock"} {
		if got := workerPermissionArgs("codex", nil, bad); got != nil {
			t.Fatalf("socket %q: %#v", bad, got)
		}
	}
	// network.enabled=true is only ever emitted together with the proxy feature.
	got := strings.Join(workerPermissionArgs("codex", nil, sock), " ")
	if !strings.Contains(got, "--enable network_proxy") || !strings.Contains(got, `mode="limited"`) {
		t.Fatalf("codex network grant is not proxied and limited: %s", got)
	}
}

func TestCodexGrantUsesTheSocketWoofdListensOn(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", filepath.Join(t.TempDir(), strings.Repeat("x", 120)))
	p, err := paths.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(p.Sock, p.Dir) || !strings.HasPrefix(p.Sock, "/tmp/woof-") {
		t.Fatalf("expected the short socket fallback, got %s", p.Sock)
	}
	if got := workerPermissionArgs("codex", nil, p.Sock); !reflect.DeepEqual(got, codexGrant(p.Sock)) {
		t.Fatalf("fallback socket: %#v", got)
	}
}

func TestWorkerPermissionsRespectLaunchChoices(t *testing.T) {
	const sock = "/tmp/woof.sock"
	conflicts := map[string][][]string{
		"claude": {
			{"--settings", "/x/settings.json"}, {"--settings={}"},
			{"--allowedTools", "Bash(git *)"}, {"--allowed-tools", "Read"},
			{"--dangerously-skip-permissions"},
			{"--permission-mode", "bypassPermissions"}, {"--permission-mode=bypassPermissions"},
			{"--model", "haiku", "--settings", "{}"},
		},
		"codex": {
			{"--sandbox", "read-only"}, {"--sandbox=workspace-write"}, {"-s", "danger-full-access"}, {"-sread-only"},
			{"--dangerously-bypass-approvals-and-sandbox"}, {"--yolo"},
			{"-c", `default_permissions=":workspace"`}, {"--config", "permissions.mine={}"}, {"--config=permissions.mine={}"},
			{"-c", "sandbox_mode=read-only"}, {"-c", "sandbox_workspace_write.network_access=true"},
			{"-c", "features.network_proxy=false"}, {"--disable", "network_proxy"},
			{"--no-daemon", "--sandbox", "read-only"},
		},
	}
	for kind, cases := range conflicts {
		for _, args := range cases {
			if got := workerPermissionArgs(kind, args, sock); got != nil {
				t.Errorf("%s %q: launch choice overridden with %#v", kind, args, got)
			}
		}
	}
	kept := map[string][][]string{
		"claude": {{"--permission-mode", "acceptEdits"}, {"--permission-mode=plan"}, {"--add-dir", "/x"}, {"--disallowedTools", "WebFetch"}},
		"codex":  {{"-c", "model_reasoning_effort=high"}, {"--model", "gpt-5.5"}, {"--enable", "network_proxy"}, {"-a", "on-request"}},
	}
	for kind, cases := range kept {
		for _, args := range cases {
			if got := workerPermissionArgs(kind, args, sock); got == nil {
				t.Errorf("%s %q: unrelated arguments suppressed the defaults", kind, args)
			}
		}
	}
}

// claudeAllows applies Claude Code's rule semantics: "cmd *" matches the bare
// command and the command followed by arguments.
func claudeAllows(command string) bool {
	for _, allowed := range claudeAllowed {
		if command == allowed || strings.HasPrefix(command, allowed+" ") {
			return true
		}
	}
	for _, exact := range claudeExact {
		if command == exact {
			return true
		}
	}
	return false
}

// A worker reads its identity one variable per command: BSD printenv prints
// only the first name, and a live Haiku worker was asked for every other shape.
func TestClaudeAllowsOnlyTheTwoExactIdentityReads(t *testing.T) {
	for _, command := range []string{"printenv WOOF_WORKER_ID", "printenv WOOF_ATTACHMENT_ID"} {
		if !claudeAllows(command) {
			t.Errorf("allow list misses %q", command)
		}
	}
	for _, command := range []string{"printenv", "printenv WOOF_WORKER_ID WOOF_ATTACHMENT_ID", "printenv WOOF_WORKER_ID ANTHROPIC_API_KEY", "printenv ANTHROPIC_API_KEY", "printenv WOOF_STATE_DIR"} {
		if claudeAllows(command) {
			t.Errorf("allow list covers %q", command)
		}
	}
	settings := workerPermissionArgs("claude", nil, "")[1]
	for _, rule := range []string{`"Bash(printenv WOOF_WORKER_ID)"`, `"Bash(printenv WOOF_ATTACHMENT_ID)"`} {
		if !strings.Contains(settings, rule) {
			t.Errorf("settings lack exact rule %s", rule)
		}
	}
	if strings.Contains(settings, "printenv WOOF_WORKER_ID *") {
		t.Error("identity read must be an exact rule, not a prefix rule")
	}
}

func TestClaudeAllowListIsTheWorkerCoordinationFlowOnly(t *testing.T) {
	ops := map[string]bool{"inbox": true, "message.show": true, "ack": true, "consume": true, "reply": true, "dispatch.show": true, "check": true, "done": true,
		"worker.show": true, "status": true, "operation.show": true, "wait": true, "question.wait": true, "events.list": true, "events.follow": true, "send": true, "ask": true}
	for _, allowed := range claudeAllowed {
		words := strings.Fields(allowed)
		if words[0] != "woof" {
			t.Fatalf("rule %q does not start with woof", allowed)
		}
		// Parse resolves the subcommand before it reports missing required flags.
		if c, _ := cli.Parse(append(words[1:], "--json")); !ops[c.Op] {
			t.Errorf("rule %q is not a worker-flow subcommand: op %q", allowed, c.Op)
		}
	}
	denied := []string{
		"woof worker start --profile claude", "woof worker spawn --profile claude", "woof worker adopt --pane p", "woof worker register --pane p",
		"woof worker stop --id w", "woof worker release --id w --force", "woof worker retain --id w", "woof worker read --id w", "woof worker list", "woof workers",
		"woof dispatch --to w --spec x", "woof dispatch nudge --id d --reason r", "woof dispatch fail --id d --reason r", "woof nudge --id d --reason r", "woof fail --id d --reason r",
		"woof schedule add --name n", "woof schedule remove s", "woof schedule rm s", "woof schedule run s", "woof schedule enable s", "woof schedule disable s", "woof schedule list", "woof schedules",
		"woof session attach --socket s", "woof session list", "woof daemon stop", "woof daemon restart",
		"woof gate create --question q", "woof gate resolve --id g --decision d", "woof operation resolve --id o --resolution r", "woof operation list",
		"woof run create --title t", "woof profile show --id p", "woof tui", "woof", "woof --version",
		"herdr agent list", "curl https://example.com", "woofd",
	}
	for _, command := range denied {
		if claudeAllows(command) {
			t.Errorf("allow list covers %q", command)
		}
	}
	for _, command := range []string{"woof inbox", "woof inbox --json", "woof done --dispatch d --attachment a --failed --body x", "woof dispatch check --json", "woof send --to worker:w --body hi"} {
		if !claudeAllows(command) {
			t.Errorf("allow list misses %q", command)
		}
	}
}

// spawnWith launches a worker of the given agent kind through worker.spawn and
// returns the stored worker and the argv handed to `herdr agent start`.
func spawnWith(t *testing.T, kind string, args []string, optOut bool) (model.Worker, []string) {
	t.Helper()
	e, f, _ := workerFixture(t, false)
	e.opts.Paths.Sock = "/tmp/woof-test/woof.sock"
	e.opts.Config.Profiles["p"] = profiles.Profile{Agent: kind, Args: args, Cwd: t.TempDir()}
	if optOut {
		off := false
		e.opts.Config.Defaults.WorkerPermissions = &off
	}
	f.startedKind = kind
	f.namedFile = filepath.Join(t.TempDir(), "name")
	f.shellOnTab = true
	f.info.ShellPID = 101
	setForegroundPID(f, 101)
	argvFile := filepath.Join(t.TempDir(), "argv")
	bin := filepath.Join(t.TempDir(), "fake-herdr")
	script := "#!/bin/sh\nprintf '%s' \"$3\" > \"$WOOF_TEST_NAME_FILE\"\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$WOOF_TEST_ARGV_FILE\"\nprintf '%s' '{\"result\":{\"agent\":{\"pane_id\":\"w1:p1\"}}}'\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN_PATH", bin)
	t.Setenv("WOOF_TEST_NAME_FILE", f.namedFile)
	t.Setenv("WOOF_TEST_ARGV_FILE", argvFile)
	data, _ := json.Marshal(Args{Name: "spawned", Profile: "p", ExtraArgs: []string{"--verbose"}})
	v, err := e.Handle(context.Background(), model.Request{Version: model.ExtraArgsProtocol, ID: newID("op"), Op: "worker.spawn", Scope: model.Scope{WorkspaceID: "ws_a"}, Args: data})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := get[model.Worker](context.Background(), e.store, "workers", v.(model.Worker).ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	for i, arg := range argv {
		if arg == "--" {
			return stored, argv[i+1:]
		}
	}
	return stored, nil
}

func TestSpawnAddsRecordsAndPassesDefaultPermissions(t *testing.T) {
	w, launched := spawnWith(t, "claude", []string{"--model", "haiku"}, false)
	want := []string{"--settings", claudeSettings, "--model", "haiku", "--verbose"}
	if !reflect.DeepEqual(w.Args, want) || !reflect.DeepEqual(launched, want) {
		t.Fatalf("claude worker args %#v, launched %#v", w.Args, launched)
	}
	w, launched = spawnWith(t, "codex", []string{"--model", "gpt-5.5"}, false)
	want = append(codexGrant("/tmp/woof-test/woof.sock"), "--model", "gpt-5.5", "--verbose")
	if !reflect.DeepEqual(w.Args, want) || !reflect.DeepEqual(launched, want) {
		t.Fatalf("codex worker args %#v, launched %#v", w.Args, launched)
	}
}

func TestSpawnPermissionsOptOutConflictAndOtherKinds(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		args       []string
		optOut     bool
	}{
		{"opt-out claude", "claude", []string{"--model", "haiku"}, true},
		{"opt-out codex", "codex", []string{"--model", "gpt-5.5"}, true},
		{"claude profile chooses settings", "claude", []string{"--settings", "{}"}, false},
		{"codex profile chooses sandbox", "codex", []string{"--sandbox", "read-only"}, false},
		{"other agent kind", "sleep", []string{"--literal"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, launched := spawnWith(t, tc.kind, tc.args, tc.optOut)
			want := append(append([]string{}, tc.args...), "--verbose")
			if !reflect.DeepEqual(w.Args, want) || !reflect.DeepEqual(launched, want) {
				t.Fatalf("args %#v, launched %#v, want %#v", w.Args, launched, want)
			}
		})
	}
}
