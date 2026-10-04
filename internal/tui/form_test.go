package tui

import (
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"errors"
	"fmt"
	"github.com/zielus/herdr-woof/internal/model"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func formKey(f Form, key tea.KeyPressMsg) Form { f, _ = f.Update(key); return f }
func formText(f Form, text string) Form {
	for _, r := range text {
		f = formKey(f, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	return f
}

func TestFormReviewRequiresValidBodyAndKeepsFrozenScope(t *testing.T) {
	original := Action{Kind: "send", Scope: model.Scope{SessionID: "session_a"}, To: "worker:worker_a", Label: "Builder"}
	f := NewFormAt(original, "/tmp/woof-form-review")
	if _, err := f.Review(); err == nil {
		t.Fatal("review accepted empty body")
	}
	f = formText(f, "Subject")
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyTab})
	f = formText(f, "Line one")
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyEnter})
	f = formText(f, "Line two")
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyTab})
	f = formText(f, "report.md")
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyEnter})
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyEnter})
	f = formText(f, "image.png")
	a, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	if a.Scope != original.Scope || a.To != original.To || a.Subject != "Subject" || a.Body != "Line one\nLine two" || !reflect.DeepEqual(a.Artifacts, []string{"/tmp/woof-form-review/report.md", "/tmp/woof-form-review/image.png"}) {
		t.Fatalf("review = %+v", a)
	}
	_, cmd := f.Update(tea.KeyPressMsg{Code: 's', Mod: tea.ModCtrl})
	if cmd == nil {
		t.Fatal("Ctrl+s did not request review")
	}
	if _, ok := cmd().(FormReviewMsg); !ok {
		t.Fatal("Ctrl+s emitted wrong message")
	}
	if !strings.Contains(f.View(80, 24), "Ctrl+s") {
		t.Fatal("missing review instruction")
	}
}

func TestFormGateSelectsOnlyFrozenOptions(t *testing.T) {
	options := []string{"approve", "reject"}
	f := NewForm(Action{Kind: "gate.resolve", ID: "gate_a", Options: options})
	options[0] = "changed"
	f = formKey(f, tea.KeyPressMsg{Code: tea.KeyDown})
	a, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	if a.Decision != "reject" {
		t.Fatalf("decision = %q", a.Decision)
	}
	a.Options[0] = "tampered"
	again, err := f.Review()
	if err != nil || again.Options[0] != "approve" {
		t.Fatal("review aliases mutable option slice")
	}
}

func TestFormFreeDecisionAndReceiptReview(t *testing.T) {
	f := NewForm(Action{Kind: "gate.resolve", ID: "gate_a"})
	if _, err := f.Review(); err == nil {
		t.Fatal("empty gate decision accepted")
	}
	f = formText(f, "ship tomorrow")
	a, err := f.Review()
	if err != nil || a.Decision != "ship tomorrow" {
		t.Fatalf("free decision: %+v %v", a, err)
	}
	receipt := NewForm(Action{Kind: "consume", ID: "msg_a"})
	a, err = receipt.Review()
	if err != nil || a.Kind != "consume" || a.ID != "msg_a" {
		t.Fatalf("receipt review %+v %v", a, err)
	}
}

func TestFormEscNeverRequestsReviewAndLabelsCannotEmitControls(t *testing.T) {
	f := NewForm(Action{Kind: "gate.resolve", ID: "gate_a", Label: "\x1b[2Jhostile\nlabel", Options: []string{"yes\x1b[31m"}})
	_, cmd := f.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if cmd != nil {
		t.Fatal("Escape requested review")
	}
	view := f.View(80, 24)
	if strings.Contains(view, "\x1b[2J") || strings.Contains(view, "\x1b[31m") {
		t.Fatal("untrusted controls reached renderer")
	}
}

func TestFormReviewCanonicalizesArtifactReferencesBeforeConfirmation(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	f := NewForm(Action{Kind: "send", To: "human", Body: "References", Artifacts: []string{"report.md", "./report.md", "~/woof-review-report.md"}})
	reviewed, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(cwd, "report.md"), filepath.Join(home, "woof-review-report.md")}
	if !reflect.DeepEqual(reviewed.Artifacts, want) {
		t.Fatalf("confirmed refs=%q want canonical=%q", reviewed.Artifacts, want)
	}
}

func TestFormCapturesOperatorDirectoryBeforeReview(t *testing.T) {
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	f := NewForm(Action{Kind: "send", To: "human", Body: "Reference", Artifacts: []string{"report.md"}})
	t.Chdir(t.TempDir())
	reviewed, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	if len(reviewed.Artifacts) != 1 || reviewed.Artifacts[0] != filepath.Join(original, "report.md") {
		t.Fatalf("artifact resolved after cwd drift: %q", reviewed.Artifacts)
	}
}

func TestFormReviewRejectsUnresolvableRelativeReferences(t *testing.T) {
	f := NewFormAt(Action{Kind: "send", To: "human", Body: "References", Artifacts: []string{"report.md"}}, "relative-cwd")
	if _, err := f.Review(); err == nil {
		t.Fatal("relative artifact reached confirmation without an absolute operator cwd")
	}
	f = NewFormAt(Action{Kind: "send", To: "human", Body: "References", Artifacts: []string{"/tmp/report.md"}}, "")
	f.cwdErr = os.ErrNotExist
	a, err := f.Review()
	if err != nil || !reflect.DeepEqual(a.Artifacts, []string{"/tmp/report.md"}) {
		t.Fatalf("absolute refs unnecessarily need cwd: %+v %v", a, err)
	}
	f = NewFormAt(Action{Kind: "send", To: "human", Body: "References", Artifacts: []string{"report.md"}}, "")
	f.cwdErr = os.ErrNotExist
	if _, err := f.Review(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cwd capture error was lost: %v", err)
	}
}

func TestArtifactReviewShowsMissingAndUnreadableLimitations(t *testing.T) {
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "report.md"), []byte("caller-owned contents"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(cwd, "not-a-file"), 0700); err != nil {
		t.Fatal(err)
	}
	f := NewFormAt(Action{Kind: "send", To: "human", Body: "References", Artifacts: []string{"report.md", "missing.md", "not-a-file"}}, cwd)
	a, err := f.Review()
	if err != nil {
		t.Fatal(err)
	}
	text := ArtifactReviewText(a)
	for _, want := range []string{filepath.Join(cwd, "report.md") + " [readable]", filepath.Join(cwd, "missing.md") + " [missing]", filepath.Join(cwd, "not-a-file") + " [unreadable]"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing reference status %q in %q", want, text)
		}
	}
	if strings.Contains(text, "caller-owned contents") {
		t.Fatal("review exposed artifact contents")
	}
}

func TestFormGateViewportKeepsSelectedLongOptionVisible(t *testing.T) {
	options := make([]string, 20)
	for i := range options {
		options[i] = fmt.Sprintf("choice-%02d %s", i, strings.Repeat("界", 60))
	}
	f := NewForm(Action{Kind: "gate.resolve", ID: "gate_a", Label: strings.Repeat("Question ", 20), Options: options})
	for range 15 {
		f = formKey(f, tea.KeyPressMsg{Code: tea.KeyDown})
	}
	view := f.View(60, 16)
	if !strings.Contains(view, "> choice-15 ") {
		t.Fatalf("selected option missing from viewport:\n%s", view)
	}
	a, err := f.Review()
	if err != nil || a.Decision != options[15] {
		t.Fatalf("visible selection differs from reviewed choice: %+v %v", a, err)
	}
	if lines := strings.Split(view, "\n"); len(lines) > 16 {
		t.Fatalf("viewport has %d lines", len(lines))
	} else {
		for _, line := range lines {
			if lipgloss.Width(line) > 60 {
				t.Fatalf("viewport line exceeds display width: %q", line)
			}
		}
	}
}
