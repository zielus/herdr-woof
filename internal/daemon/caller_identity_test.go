package daemon

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/zielus/herdr-woof/internal/herdr"
	"github.com/zielus/herdr-woof/internal/model"
	"github.com/zielus/herdr-woof/internal/store"
)

func callerChild(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestProcess(t, cmd) })
	return cmd.Process.Pid
}
func aliasCallerFixture(t *testing.T, process *model.ProcessIdentity, callerPID int) (*Engine, model.Worker, model.Caller) {
	t.Helper()
	e, _, w := fixture(t)
	w.PaneAliases = []string{"w9:p9"}
	w.AgentProcess = process
	if err := e.write(context.Background(), func(tx *store.Tx) error { return tx.Put("workers", w.ID, w) }); err != nil {
		t.Fatal(err)
	}
	session, _ := get[model.Session](context.Background(), e.store, "sessions", w.SessionID)
	return e, w, model.Caller{HerdrSocket: session.SocketPath, PaneID: "w9:p9", ProcessID: callerPID}
}
func assertUnprovenAlias(t *testing.T, e *Engine, c model.Caller) {
	t.Helper()
	got, err := e.validatedCaller(context.Background(), c)
	var me *model.Error
	if !errors.As(err, &me) || me.Code != "stale_attachment" || got.WorkerID != "" || !strings.Contains(me.Message, "--as-worker") || !strings.Contains(me.Message, "--as-attachment") {
		t.Fatalf("unproven pane alias inferred worker: caller=%+v err=%v", got, err)
	}
}
func TestHistoricalPaneAliasRejectsUnrelatedCallerProcess(t *testing.T) {
	recorded, err := birthIdentity(callerChild(t))
	if err != nil {
		t.Fatal(err)
	}
	e, _, c := aliasCallerFixture(t, &recorded, os.Getpid())
	assertUnprovenAlias(t, e, c)
}
func TestHistoricalPaneAliasAcceptsRealDescendant(t *testing.T) {
	recorded, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	e, w, c := aliasCallerFixture(t, &recorded, callerChild(t))
	got, err := e.validatedCaller(context.Background(), c)
	if err != nil || got.WorkerID != w.ID || got.AttachmentID != w.AttachmentID {
		t.Fatalf("proven descendant rejected: %+v %v", got, err)
	}
}
func TestHistoricalPaneAliasRejectsStaleProcessBirth(t *testing.T) {
	recorded, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	recorded.Birth = "obsolete-process-birth"
	e, _, c := aliasCallerFixture(t, &recorded, callerChild(t))
	assertUnprovenAlias(t, e, c)
}
func TestHistoricalPaneAliasRequiresRecordedProcessAndCallerPID(t *testing.T) {
	e, _, c := aliasCallerFixture(t, nil, callerChild(t))
	assertUnprovenAlias(t, e, c)
	recorded, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	e, _, c = aliasCallerFixture(t, &recorded, 0)
	assertUnprovenAlias(t, e, c)
}
func TestExactCurrentPaneStillUsesFreshAttachmentWithoutAncestry(t *testing.T) {
	e, w, c := aliasCallerFixture(t, nil, 0)
	c.PaneID = w.PaneID
	got, err := e.validatedCaller(context.Background(), c)
	if err != nil || got.WorkerID != w.ID {
		t.Fatalf("current pane binding rejected: %+v %v", got, err)
	}
}

func callerLineage(t *testing.T) (*model.ProcessIdentity, int) {
	t.Helper()
	cmd := exec.Command("sh", "-c", "sleep 30 & printf '%s\n' \"$!\"; wait")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		stopTestProcess(t, cmd)
		t.Fatal(err)
	}
	child, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		stopTestProcess(t, cmd)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p, err := os.FindProcess(child)
		if err != nil {
			t.Error(err)
		} else {
			killTestProcess(t, p)
		}
		stopTestProcess(t, cmd)
	})
	recorded, err := birthIdentity(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	return &recorded, child
}
func overlappingCallerFixture(t *testing.T, historicalOnly bool, reverseOrder ...bool) (*Engine, model.Worker, model.Worker, model.Caller, int, int) {
	t.Helper()
	e := sessionEngine(t)
	f := newSessionFixture(t, "current")
	session := attachFixture(t, e, f, "current")
	workspaces, err := list[model.Workspace](context.Background(), e.store, "workspaces", model.Scope{SessionID: session.ID})
	if err != nil {
		t.Fatal(err)
	}
	movedProcess, movedChild := callerLineage(t)
	currentProcess, currentChild := callerLineage(t)
	f.mu.Lock()
	currentPane := f.pane
	movedPane := currentPane
	movedPane.PaneID = "w1:p9"
	movedPane.TerminalID = "moved-terminal"
	movedName := "moved-agent"
	movedPane.Name = &movedName
	movedNative := *currentPane.AgentSession
	movedNative.Value = "moved-native-session"
	movedPane.AgentSession = &movedNative
	f.extraPanes = []herdr.Pane{movedPane}
	f.mu.Unlock()
	moved := model.Worker{ID: "worker_a_moved", Name: "moved", SessionID: session.ID, WorkspaceID: workspaces[0].ID, PaneID: movedPane.PaneID, TerminalID: movedPane.TerminalID, AgentKind: *movedPane.Agent, AgentName: movedName, NativeSession: movedPane.AgentSession, AgentProcess: movedProcess, AttachmentID: "att_moved", State: "idle"}
	current := model.Worker{ID: "worker_z_current", Name: "current", SessionID: session.ID, WorkspaceID: workspaces[0].ID, PaneID: currentPane.PaneID, TerminalID: currentPane.TerminalID, AgentKind: *currentPane.Agent, AgentName: *currentPane.Name, NativeSession: currentPane.AgentSession, AgentProcess: currentProcess, AttachmentID: "att_current", State: "idle"}
	if len(reverseOrder) > 0 && reverseOrder[0] {
		moved.ID, current.ID = current.ID, moved.ID
	}
	paneID := currentPane.PaneID
	if historicalOnly {
		paneID = "w9:p9"
		current.PaneAliases = []string{paneID}
	}
	moved.PaneAliases = []string{paneID}
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", moved.ID, moved); err != nil {
			return err
		}
		return tx.Put("workers", current.ID, current)
	}); err != nil {
		t.Fatal(err)
	}
	return e, moved, current, model.Caller{HerdrSocket: session.SocketPath, PaneID: paneID}, movedChild, currentChild
}
func TestOverlappingCurrentPaneAndAliasRouteOwnProcessLineage(t *testing.T) {
	for _, reversed := range []bool{false, true} {
		for _, selected := range []string{"moved", "current"} {
			t.Run(selected+"/reversed="+strconv.FormatBool(reversed), func(t *testing.T) {
				e, moved, current, c, movedChild, currentChild := overlappingCallerFixture(t, false, reversed)
				expected := moved
				c.ProcessID = movedChild
				if selected == "current" {
					expected = current
					c.ProcessID = currentChild
				}
				got, err := e.validatedCaller(context.Background(), c)
				if err != nil || got.WorkerID != expected.ID {
					t.Fatalf("caller routed by numerical pane instead of lineage: %+v %v want %s", got, err, expected.ID)
				}
			})
		}
	}
}
func TestOverlappingCurrentPaneAndAliasRequireCallerProcess(t *testing.T) {
	e, _, _, c, _, _ := overlappingCallerFixture(t, false)
	assertUnprovenAlias(t, e, c)
}
func TestHistoricalAliasChecksAllCandidatesBeforeChoosingProvenWorker(t *testing.T) {
	e, _, current, c, _, child := overlappingCallerFixture(t, true)
	c.ProcessID = child
	got, err := e.validatedCaller(context.Background(), c)
	if err != nil || got.WorkerID != current.ID {
		t.Fatalf("first unrelated alias prevented proven later candidate: %+v %v", got, err)
	}
}

func TestOverlappingCallerRejectsTwoProvenWorkerBindings(t *testing.T) {
	e, moved, current, c, _, _ := overlappingCallerFixture(t, false)
	common, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	moved.AgentProcess, current.AgentProcess = &common, &common
	if err := e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workers", moved.ID, moved); err != nil {
			return err
		}
		return tx.Put("workers", current.ID, current)
	}); err != nil {
		t.Fatal(err)
	}
	c.ProcessID = callerChild(t)
	assertUnprovenAlias(t, e, c)
}
