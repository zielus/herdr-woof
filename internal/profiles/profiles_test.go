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
