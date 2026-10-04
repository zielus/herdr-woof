package cli

import (
	"bytes"
	"context"
	"github.com/zielus/herdr-woof/internal/model"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTUIExplicitScopeAndGlobalDefault(t *testing.T) {
	c, err := Parse([]string{"tui"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Op != "tui" || c.ApplyScope(model.Scope{Global: true}) != (model.Scope{Global: true}) {
		t.Fatalf("command=%+v", c)
	}
	c, err = Parse([]string{"tui", "--workspace", "ws_target"})
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ApplyScope(model.Scope{Global: true}); got != (model.Scope{WorkspaceID: "ws_target"}) {
		t.Fatalf("scope=%+v", got)
	}
}
func TestTUIRejectsMachineOutputAndActorOverride(t *testing.T) {
	for _, argv := range [][]string{
		{"tui", "--json"},
		{"tui", "--as-worker", "w1", "--as-attachment", "a1"},
		{"tui", "--body", "not-a-message"},
		{"tui", "unexpected"},
	} {
		if _, err := Parse(argv); err == nil {
			t.Fatalf("accepted %v", argv)
		}
	}
}

func TestTUIRejectsNonTerminalBeforeStateCreation(t *testing.T) {
	state := filepath.Join(t.TempDir(), "untouched-state")
	t.Setenv("WOOF_STATE_DIR", state)
	var out, errOut bytes.Buffer
	if code := Run(context.Background(), []string{"tui"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "terminal") {
		t.Fatalf("code=%d error=%s", code, &errOut)
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("non-terminal command created runtime state: %v", err)
	}
}
func TestTUIHelpDoesNotBootstrap(t *testing.T) {
	state := filepath.Join(t.TempDir(), "untouched-state")
	t.Setenv("WOOF_STATE_DIR", state)
	var out, errOut bytes.Buffer
	if code := Run(context.Background(), []string{"tui", "--help"}, &out, &errOut); code != 0 || !strings.Contains(out.String(), "tui") {
		t.Fatalf("code=%d out=%s err=%s", code, &out, &errOut)
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("help created runtime state: %v", err)
	}
}
