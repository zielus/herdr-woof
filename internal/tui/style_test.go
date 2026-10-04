package tui

import (
	"context"
	"regexp"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
	"github.com/zielus/herdr-woof-v2/internal/model"
)

func TestStyledTerminalRetainsSelectionStatusAndSafeBounds(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "worker_0123456789abcdef0123456789abcdef", Name: "界🙂 agent\x1b]52;c;evil\a", State: "blocked"}}})
	m.Update(tea.ColorProfileMsg{Profile: colorprofile.ANSI})
	sgr := regexp.MustCompile("\x1b\\[[0-9;]*m")
	for _, size := range [][2]int{{60, 16}, {99, 24}, {100, 30}, {180, 40}} {
		m.width, m.height = size[0], size[1]
		text := m.View().Content
		if !strings.Contains(text, "\x1b[") {
			t.Fatal("color capable terminal has no styled hierarchy")
		}
		if strings.ContainsAny(sgr.ReplaceAllString(text, ""), "\x1b\r\a") {
			t.Fatal("data emitted terminal controls")
		}
		if !strings.Contains(ansi.Strip(text), "[blocked]") {
			t.Fatal("status lost behind the ID")
		}
		if !strings.Contains(ansi.Strip(text), "> 界🙂 agent") {
			t.Fatal("selection marker lost")
		}
		if len(strings.Split(text, "\n")) > size[1] {
			t.Fatal("height overflow")
		}
		for _, line := range strings.Split(text, "\n") {
			if ansi.StringWidth(line) > size[0] {
				t.Fatal("styled width overflow")
			}
		}
	}
}

func TestNoColorAndASCIIKeepAllOperatorText(t *testing.T) {
	for _, tc := range []struct {
		name, term, noColor string
		profile             colorprofile.Profile
	}{
		{"ascii", "xterm-256color", "", colorprofile.Ascii},
		{"no-color", "xterm-256color", "1", colorprofile.TrueColor},
		{"dumb", "dumb", "", colorprofile.TrueColor},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NO_COLOR", tc.noColor)
			t.Setenv("TERM", tc.term)
			m := newModel(context.Background(), nil, model.Scope{Global: true})
			defer m.cancel()
			m.Update(tea.ColorProfileMsg{Profile: tc.profile})
			text := m.View().Content
			if strings.Contains(text, "\x1b") {
				t.Fatal("plain terminal emitted styles")
			}
			for _, label := range []string{"Woof", "[1 Workers]", "STALE", "actions disabled", "Filter:", "q quit"} {
				if !strings.Contains(text, label) {
					t.Fatalf("plain terminal lost %q", label)
				}
			}
		})
	}
}

func TestWorkerListPutsStatusBeforeLongIdentity(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "worker_0123456789abcdef0123456789abcdef", Name: "reviewer", State: "idle", Ready: true}}})
	line := m.listLines(40, 10)[0]
	if !strings.Contains(line, "[idle]") || !strings.Contains(line, "ready:true") {
		t.Fatalf("essential state hidden: %s", line)
	}
}
