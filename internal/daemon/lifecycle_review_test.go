package daemon

import (
	"context"
	"encoding/json"
	"github.com/zielus/herdr-woof-v2/internal/herdr"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
	"os"
	"testing"
)

func TestVersionNamedClaudeProcessUsesLaunchArgv(t *testing.T) {
	var info herdr.ProcessInfo
	b, _ := json.Marshal(map[string]any{"shell_pid": 0, "foreground_processes": []any{map[string]any{"pid": os.Getpid(), "name": "2.1.288", "argv0": "claude", "argv": []string{"claude", "--model", "sonnet"}}}})
	if err := json.Unmarshal(b, &info); err != nil {
		t.Fatal(err)
	}
	_, agent, err := processEvidence(info, "claude")
	if err != nil || agent == nil {
		t.Fatalf("version-named live Claude not identified %+v %v", agent, err)
	}
}
func TestWorkerScopeFollowsMovedPaneWhileDispatchKeepsOriginalWorkspace(t *testing.T) {
	e, _, w := fixture(t)
	d := mustDispatch(t, e, w)
	_ = e.write(context.Background(), func(tx *store.Tx) error {
		if err := tx.Put("workspaces", "moved_ws", model.Workspace{ID: "moved_ws", SessionID: w.SessionID, HerdrWorkspaceID: "w2"}); err != nil {
			return err
		}
		current, err := txGet[model.Worker](tx, "workers", w.ID)
		if err != nil {
			return err
		}
		current.WorkspaceID = "moved_ws"
		current.PaneID = "w2:p1"
		return tx.Put("workers", w.ID, current)
	})
	s, err := e.normalizeScope(context.Background(), model.Request{Caller: model.Caller{WorkerID: w.ID, AttachmentID: w.AttachmentID}, Scope: model.Scope{WorkspaceID: w.WorkspaceID, WorkerID: w.ID}})
	if err != nil || s.RunID != d.RunID {
		t.Fatalf("moved dispatch context invalid %+v %v", s, err)
	}
}
