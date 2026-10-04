package profiles

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func loadText(t *testing.T, text string) (Config, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(p, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return Load(p)
}

func TestRawArgsDefaultAndIndependentSnapshots(t *testing.T) {
	t.Setenv("HOME", "/home/worker")
	c, err := loadText(t, `profiles:
  luna:
    agent: omp
    args: [--config, ~/a.yml, --x=~/b, ~x, '$VAR', '$(touch marker)', '"literal quote"']
    description: Cheap tier
    tags: [cheap, small-task]
  deep:
    agent: codex
    args: [--model, gpt-5.5, -c, model_reasoning_effort=high]
defaults:
  worker_profile: luna
`)
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.Resolve("")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config", "/home/worker/a.yml", "--x=/home/worker/b", "~x", "$VAR", "$(touch marker)", `"literal quote"`}
	if p.Agent != "omp" || !reflect.DeepEqual(p.Args, want) {
		t.Fatalf("resolved profile=%+v", p)
	}
	p.Args[0] = "changed"
	p.Tags[0] = "changed"
	again, _ := c.Resolve("luna")
	if again.Args[0] != "--config" || again.Tags[0] != "cheap" {
		t.Fatal("launch mutated stored profile")
	}
	explicit, err := c.Resolve("deep")
	if err != nil || explicit.Agent != "codex" || len(explicit.Args) != 4 {
		t.Fatalf("explicit=%+v err=%v", explicit, err)
	}
	roster := Roster(c)
	if len(roster) != 2 || roster[0].Name != "deep" || roster[1].Description != "Cheap tier" {
		t.Fatalf("roster=%+v", roster)
	}
	encoded, _ := json.Marshal(roster)
	if strings.Contains(string(encoded), "args") || strings.Contains(string(encoded), "env") {
		t.Fatalf("roster leaked launch details: %s", encoded)
	}
}

func TestRejectMalformedUnknownAndInvalidProfiles(t *testing.T) {
	for _, text := range []string{"", "profiles: [", "profiles: {}", "profiles:\n  Bad.Name:\n    agent: claude", "profiles:\n  good:\n    agent: ''", "profiles:\n  good:\n    agent: claude\n    model: opus", "profiles:\n  good:\n    agent: claude\n    effort: high", "profiles:\n  good:\n    agent: claude\n    env: {TOKEN: secret}", "profiles:\n  good:\n    agent: claude\n    args: not-a-list", "profiles:\n  good:\n    agent: claude\n    args: [42, true]", "profiles:\n  good:\n    agent: claude\n    description: 123", "profiles:\n  good:\n    agent: claude\n---\nprofiles: {}", "profiles:\n  good:\n    agent: claude\ndefaults:\n  worker_profile: missing"} {
		t.Run(text, func(t *testing.T) {
			if _, err := loadText(t, text); err == nil {
				t.Fatalf("accepted malformed config %q", text)
			}
		})
	}
}

func TestMissingAndUnknownProfileErrors(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yml")); err == nil {
		t.Fatal("missing config accepted")
	}
	c, err := loadText(t, "profiles:\n  claude:\n    agent: claude\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(""); err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("missing default: %v", err)
	}
	if _, err := c.Resolve("missing"); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("unknown name: %v", err)
	}
	if _, err := c.Resolve("claude"); err != nil {
		t.Fatal(err)
	}
}

func TestCwdIsResolvedFromConfigWithoutChangingConfiguredText(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "config space")
	for _, dir := range []string{configDir, filepath.Join(root, "workspace"), filepath.Join(configDir, "日本語 $VAR $(noop) *")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	configPath := filepath.Join(configDir, "config.yml")
	raw := "日本語 $VAR $(noop) *"
	if err := os.WriteFile(configPath, []byte("profiles:\n  local:\n    agent: claude\n    cwd: '"+raw+"'\ndefaults:\n  worker_profile: local\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(filepath.Join(root, "workspace")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	p, err := cfg.Resolve("")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(configDir, raw); p.Cwd != want {
		t.Fatalf("resolved cwd = %q, want %q", p.Cwd, want)
	}
	if cfg.Profiles["local"].Cwd != raw {
		t.Fatalf("configured cwd changed: %q", cfg.Profiles["local"].Cwd)
	}
	encoded, err := json.Marshal(cfg.Profiles["local"])
	if err != nil || !strings.Contains(string(encoded), raw) {
		t.Fatalf("profile show data = %s: %v", encoded, err)
	}
}

func TestCwdAbsoluteHomeAndAbsent(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	cfg, err := loadText(t, "profiles:\n  absolute:\n    agent: claude\n    cwd: '"+root+"'\n  home:\n    agent: claude\n    cwd: ~/folder\n  old:\n    agent: claude\n")
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"absolute": root, "home": filepath.Join(root, "folder"), "old": ""} {
		p, err := cfg.Resolve(name)
		if err != nil || p.Cwd != want {
			t.Errorf("%s cwd = %q, %v; want %q", name, p.Cwd, err, want)
		}
	}
}

func TestRejectNonStringCwd(t *testing.T) {
	for _, value := range []string{"42", "true", "[path]", "{path: x}", "null"} {
		if _, err := loadText(t, "profiles:\n  worker:\n    agent: claude\n    cwd: "+value+"\n"); err == nil {
			t.Errorf("accepted cwd %s", value)
		}
	}
}

func TestWorkerPermissionsDefaultOnAndOptOut(t *testing.T) {
	const base = "profiles:\n  a:\n    agent: claude\n"
	for text, want := range map[string]bool{
		base: true,
		base + "defaults:\n  worker_profile: a\n":                              true,
		base + "defaults:\n  worker_permissions: true\n":                       true,
		base + "defaults:\n  worker_profile: a\n  worker_permissions: false\n": false,
	} {
		c, err := loadText(t, text)
		if err != nil {
			t.Fatalf("%q: %v", text, err)
		}
		if got := c.Defaults.PermissionsEnabled(); got != want {
			t.Errorf("%q: enabled = %v, want %v", text, got, want)
		}
	}
	for _, bad := range []string{"defaults:\n  worker_permissions: sometimes\n", "defaults:\n  worker_permission: false\n", "defaults:\n  worker_permissions: [woof inbox]\n"} {
		if _, err := loadText(t, base+bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
