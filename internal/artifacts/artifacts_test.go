package artifacts

import (
	"github.com/zielus/herdr-woof-v2/internal/model"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveCallerPathsAndStatusWithoutContent(t *testing.T) {
	cwd := t.TempDir()
	t.Setenv("HOME", cwd)
	file := filepath.Join(cwd, "report.md")
	if err := os.WriteFile(file, []byte("PRIVATE HANDOFF CONTENT"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := Resolve([]string{"report.md", "~/report.md", "sub/../missing.md"}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != file || got[1].Path != filepath.Join(cwd, "missing.md") {
		t.Fatalf("paths=%+v", got)
	}
	status := Status(got)
	if len(status) != 2 || !status[0].Exists || !status[0].Readable || status[1].Exists || status[1].Error == "" {
		t.Fatalf("status=%+v", status)
	}
}

func TestInvalidPathsAndDirectories(t *testing.T) {
	for _, paths := range [][]string{{""}, {"bad\x00path"}} {
		if _, err := Resolve(paths, t.TempDir()); err == nil {
			t.Fatalf("accepted %q", paths)
		}
	}
	if _, err := Resolve([]string{"relative.md"}, ""); err == nil {
		t.Fatal("resolved against daemon cwd")
	}
	dir := t.TempDir()
	status := Status([]model.Artifact{{Path: dir}})
	if !status[0].Exists || status[0].Readable || status[0].Error == "" {
		t.Fatalf("directory status=%+v", status)
	}
}
