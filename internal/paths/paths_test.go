package paths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGlobalPrivatePaths(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", filepath.Join(t.TempDir(), "state"))
	t.Setenv("WOOF_CONFIG", "/tmp/custom.yml")
	t.Setenv("HERDR_SESSION", "one")
	a, e := Resolve()
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("HERDR_SESSION", "two")
	t.Setenv("HERDR_SOCKET_PATH", "elsewhere")
	b, e := Resolve()
	if e != nil || a != b {
		t.Fatalf("session affected global state: %v", e)
	}
	if a.Config != "/tmp/custom.yml" {
		t.Fatal(a)
	}
	for _, d := range []string{a.Dir, a.Archive, filepath.Dir(a.Sock)} {
		st, e := os.Stat(d)
		if e != nil || st.Mode().Perm() != 0700 {
			t.Fatalf("private dir %s: %v %v", d, st, e)
		}
	}
	if _, e := os.Stat(a.DB); !os.IsNotExist(e) {
		t.Fatal("Resolve opened DB")
	}
}
func TestLongPathFallback(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", filepath.Join(t.TempDir(), strings.Repeat("x", 120)))
	p, e := Resolve()
	if e != nil {
		t.Fatal(e)
	}
	if len(p.Sock) > 100 || filepath.Dir(p.Lock) != p.Dir {
		t.Fatal(p)
	}
	q, e := Resolve()
	if e != nil || p.Sock != q.Sock {
		t.Fatal("unstable fallback")
	}
}
func TestCanonicalStateAliasSharesSocket(t *testing.T) {
	d := t.TempDir()
	real := filepath.Join(d, strings.Repeat("long", 30))
	if e := os.Mkdir(real, 0700); e != nil {
		t.Fatal(e)
	}
	alias := filepath.Join(d, "alias")
	if e := os.Symlink(real, alias); e != nil {
		t.Fatal(e)
	}
	t.Setenv("WOOF_STATE_DIR", filepath.Join(real, "state"))
	p, e := Resolve()
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("WOOF_STATE_DIR", filepath.Join(alias, "state"))
	q, e := Resolve()
	if e != nil {
		t.Fatal(e)
	}
	if p.Sock != q.Sock || p.Lock != q.Lock {
		t.Fatalf("state aliases split daemon discovery: %s %s", p.Sock, q.Sock)
	}
}
func TestRelativeConfigResolvedBeforeDaemonChangesDirectory(t *testing.T) {
	t.Setenv("WOOF_STATE_DIR", t.TempDir())
	t.Setenv("WOOF_CONFIG", "profiles.yml")
	p, e := Resolve()
	if e != nil {
		t.Fatal(e)
	}
	expected, e := filepath.Abs("profiles.yml")
	if e != nil {
		t.Fatal(e)
	}
	if p.Config != expected {
		t.Fatalf("relative config will change meaning on bootstrap: %s", p.Config)
	}
}

func TestResolveOnlyChmodsWhenTheModeIsWrong(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	t.Setenv("WOOF_STATE_DIR", dir)
	if _, e := Resolve(); e != nil {
		t.Fatal(e)
	}
	// A sandbox that allows using the state directory may still refuse chmod.
	var calls []string
	chmod = func(name string, _ os.FileMode) error {
		calls = append(calls, name)
		return os.ErrPermission
	}
	t.Cleanup(func() { chmod = os.Chmod })
	if _, e := Resolve(); e != nil || len(calls) != 0 {
		t.Fatalf("private state dir was chmodded: %v %v", calls, e)
	}
	// A directory that is not private is still corrected, and a refusal is an error.
	if e := os.Chmod(dir, 0755); e != nil {
		t.Fatal(e)
	}
	if _, e := Resolve(); e == nil || len(calls) != 1 {
		t.Fatalf("loose state dir accepted: %v %v", calls, e)
	}
	chmod = os.Chmod
	if _, e := Resolve(); e != nil {
		t.Fatal(e)
	}
	if st, e := os.Stat(dir); e != nil || st.Mode().Perm() != 0700 {
		t.Fatalf("state dir not restored to 0700: %v %v", st, e)
	}
}
