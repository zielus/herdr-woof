package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/zielus/herdr-woof/internal/model"
	"reflect"
	"strings"
	"testing"
)

func TestWorkerStartLiteralExtraArgs(t *testing.T) {
	want := []string{"--", "", "żółć", "--leading", "$(touch /tmp/never)", "a b"}
	argv := []string{"worker", "start", "--name=x"}
	for _, value := range want {
		argv = append(argv, "--arg="+value)
	}
	c, err := Parse(argv)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		ExtraArgs []string `json:"extra_args"`
	}
	b, err := json.Marshal(c.Args)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(payload.ExtraArgs, want) {
		t.Fatalf("extra argv = %#v, want %#v", payload.ExtraArgs, want)
	}
	for _, args := range [][]string{{"send", "--to=x", "--body=x", "--arg=y"}, {"worker", "adopt", "--pane=x", "--arg=y"}, {"worker", "start", "--arg=x\x00y"}} {
		if _, err := Parse(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}

func TestCommandPayloadAndExplicitScope(t *testing.T) {
	c, err := Parse([]string{"send", "--to", "worker:w_123", "--body", "please inspect", "--artifact", "./handoff.md", "--artifact", "/tmp/report.md", "--workspace", "ws_new", "--json"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Op != "send" || c.Args.To != "worker:w_123" || c.Args.Body != "please inspect" || len(c.Args.Artifacts) != 2 || !c.JSON {
		t.Fatalf("command=%+v", c)
	}
	inherited := model.Scope{SessionID: "s_old", WorkspaceID: "ws_old", RunID: "r_old", WorkerID: "w_old", WorktreeID: "wt_old"}
	got := c.ApplyScope(inherited)
	if got.WorkspaceID != "ws_new" || got.SessionID != "" || got.RunID != "" || got.WorkerID != "" || got.WorktreeID != "" {
		t.Fatalf("scope=%+v", got)
	}
	global, err := Parse([]string{"--global", "inbox"})
	if err != nil {
		t.Fatal(err)
	}
	if got := global.ApplyScope(inherited); got != (model.Scope{Global: true}) {
		t.Fatalf("global=%+v", got)
	}
	local, err := Parse([]string{"inbox"})
	if err != nil {
		t.Fatal(err)
	}
	if local.ApplyScope(inherited) != inherited {
		t.Fatal("lost valid inherited scope")
	}
}

func TestErrorRetainsDurableQuestionRecovery(t *testing.T) {
	err := fmt.Errorf("question msg_123 remains durable; use woof question wait --id msg_123: %w", &model.Error{Code: "timeout", Message: "wait timed out", OperationID: "op_456"})
	var out bytes.Buffer
	writeError(&out, err, true)
	var response struct {
		Error model.Error `json:"error"`
	}
	if e := json.Unmarshal(out.Bytes(), &response); e != nil {
		t.Fatal(e)
	}
	if response.Error.Code != "timeout" || response.Error.OperationID != "op_456" || !strings.Contains(response.Error.Message, "msg_123") {
		t.Fatalf("lost recovery context: %s", out.String())
	}
}

func TestVersionFlagRetainsMachineOutput(t *testing.T) {
	c, err := Parse([]string{"--version", "--json"})
	if err != nil || c.Op != "version" || !c.JSON {
		t.Fatalf("version: %+v %v", c, err)
	}
}

func TestDispatchReportingPreservesAttachment(t *testing.T) {
	c, err := Parse([]string{"done", "--dispatch", "d_123", "--attachment", "a_original", "--failed", "--body", "blocked", "--artifact", "/tmp/result.md"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Op != "done" || c.Args.Dispatch != "d_123" || c.Args.Attachment != "a_original" || c.Args.Outcome != "failed" {
		t.Fatalf("command=%+v", c)
	}
	b, _ := json.Marshal(c.Args)
	if !strings.Contains(string(b), `"attachment":"a_original"`) {
		t.Fatalf("payload=%s", b)
	}
}

func TestDurationCursorAndEventSelection(t *testing.T) {
	c, err := Parse([]string{"wait", "--events", "message,worker.done", "--timeout", "20m", "--since", "1842"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Op != "wait" || c.Args.Timeout != 1200000 || c.Args.Since == nil || *c.Args.Since != 1842 || len(c.Args.Events) != 2 {
		t.Fatalf("wait=%+v", c)
	}
	follow, err := Parse([]string{"events", "follow", "--since=0", "--run=r_123"})
	if err != nil {
		t.Fatal(err)
	}
	if !follow.Follow || follow.Op != "events.follow" {
		t.Fatalf("follow=%+v", follow)
	}
}

func TestAliasesAndTargetSelection(t *testing.T) {
	cases := []struct {
		argv   []string
		op, id string
	}{
		{[]string{"worker", "start", "--name", "builder", "--profile", "claude"}, "worker.spawn", ""},
		{[]string{"worker", "register", "--pane", "w1:p2", "--name", "reviewer"}, "worker.adopt", ""},
		{[]string{"worker", "show", "w_123"}, "worker.show", "w_123"},
		{[]string{"worker", "release", "--worker", "w_123"}, "worker.release", "w_123"},
		{[]string{"message", "show", "--id", "m_123"}, "message.show", "m_123"},
		{[]string{"message", "ack", "m_123"}, "ack", "m_123"},
		{[]string{"profile", "list"}, "profile.roster", ""},
		{[]string{"gate", "resolve", "g_123", "--decision", "yes"}, "gate.resolve", "g_123"},
		{[]string{"operation", "show", "op_123"}, "operation.show", "op_123"},
	}
	for _, tc := range cases {
		c, err := Parse(tc.argv)
		if err != nil {
			t.Fatalf("%v: %v", tc.argv, err)
		}
		if c.Op != tc.op || c.Args.ID != tc.id {
			t.Fatalf("%v: %+v", tc.argv, c)
		}
	}
}

func TestReadoptionPreservesLogicalWorkerIDWithoutNewAlias(t *testing.T) {
	for _, flag := range []string{"--id", "--worker"} {
		c, err := Parse([]string{"worker", "adopt", flag, "worker_prior", "--pane", "w2:p7", "--workspace", "workspace_new"})
		if err != nil {
			t.Fatal(err)
		}
		if c.Op != "worker.adopt" || c.Args.ID != "worker_prior" || c.Args.Pane != "w2:p7" || c.Args.Name != "" {
			t.Fatalf("readoption=%+v", c)
		}
	}
	if _, err := Parse([]string{"worker", "adopt", "--id", "worker_prior"}); err == nil {
		t.Fatal("readoption must require an explicit pane")
	}
}

func TestExplicitActorFlagsRequirePairedIdentity(t *testing.T) {
	c, err := Parse([]string{"send", "--to", "worker:worker_target", "--body", "hello", "--as-worker", "worker_actor", "--as-attachment", "attachment_live"})
	if err != nil {
		t.Fatal(err)
	}
	if c.AsWorker != "worker_actor" || c.AsAttachment != "attachment_live" || c.HasScope || c.Args.To != "worker:worker_target" {
		t.Fatalf("actor changed selected scope or target: %+v", c)
	}
	for _, argv := range [][]string{{"status", "--as-worker", "worker_actor"}, {"status", "--as-attachment", "attachment_live"}, {"status", "--as-worker=", "--as-attachment=attachment_live"}} {
		if _, err := Parse(argv); err == nil {
			t.Fatalf("accepted incomplete actor: %v", argv)
		}
	}
	list, err := Parse([]string{"operation", "list", "--global", "--json"})
	if err != nil || list.Op != "operation.list" {
		t.Fatalf("operation list=%+v %v", list, err)
	}
}

func TestRejectUnknownIncompleteAndConflictingFlags(t *testing.T) {
	cases := [][]string{{"nonsense"}, {"send", "--to", "worker:w_123"}, {"send", "--to", "worker:w_123", "--body", "x", "--typo", "y"}, {"done", "--dispatch", "d_123"}, {"worker", "release"}, {"events", "follow", "--since", "-1"}, {"wait", "--timeout", "oops"}, {"wait", "--timeout", "0s"}, {"inbox", "--limit", "0"}, {"inbox", "--global", "--workspace", "ws_1"}, {"gate", "resolve", "g_1"}, {"worker", "show", "w_1", "extra"}}
	for _, argv := range cases {
		if _, err := Parse(argv); err == nil {
			t.Fatalf("accepted %v", argv)
		}
	}
}

func TestHelpHasNoRuntimeDependency(t *testing.T) {
	for _, argv := range [][]string{{"--help"}, {"worker", "--help"}, {"send", "--help"}, {}} {
		c, err := Parse(argv)
		if err != nil || !c.Help {
			t.Fatalf("help %v: %+v %v", argv, c, err)
		}
	}
}
