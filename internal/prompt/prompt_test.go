package prompt

import (
	"github.com/zielus/herdr-woof-v2/internal/model"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDonorANSIDrafts(t *testing.T) {
	for _, kind := range []string{"claude", "codex", "pi", "cursor", "gemini", "opencode"} {
		for _, state := range []string{"empty", "draft"} {
			t.Run(kind+"-"+state, func(t *testing.T) {
				screen, err := os.ReadFile("testdata/" + kind + "-" + state + ".ansi")
				if err != nil {
					t.Fatal(err)
				}
				want := Empty
				if state == "draft" {
					want = Typed
				}
				if got := Inspect(kind, string(screen)); got != want {
					t.Fatalf("got %v want %v", got, want)
				}
				if Safe(kind, string(screen)) != (want == Empty) {
					t.Fatal("safe draft mismatch")
				}
			})
		}
	}
	for _, name := range []string{"claude-empty-after-turn", "opencode-empty-session"} {
		screen, _ := os.ReadFile("testdata/" + name + ".ansi")
		kind := strings.Split(name, "-")[0]
		if Inspect(kind, string(screen)) != Empty {
			t.Fatalf("%s not empty", name)
		}
	}
}

func TestUnknownMenusMultilineAndCursor(t *testing.T) {
	rule := strings.Repeat("─", 40)
	cases := []struct {
		kind, screen string
		want         State
	}{
		{"omp", rule + "\n\n" + rule, Unknown},
		{"unsupported", "› ", Unknown},
		{"claude", "some output\nno box", Unknown},
		{"codex", "Do you trust this directory?\n\x1b[1m›\x1b[0m 1. Yes, continue\n2. No, quit", Typed},
		{"claude", rule + "\n❯ \n second line typed\n" + rule, Typed},
		{"claude", rule + "\n❯ \x1b[2mTry fix lint\x1b[0m\n" + rule, Empty},
		{"pi", rule + "\n\x1b[7mx\x1b[0m\n" + rule, Typed},
		{"cursor", "\x1b[2m→ \x1b[0m\x1b[7mP\x1b[0m\x1b[2mlan, search\x1b[0m", Empty},
	}
	for _, c := range cases {
		if got := Inspect(c.kind, c.screen); got != c.want {
			t.Fatalf("%s %q got %v want %v", c.kind, c.screen, got, c.want)
		}
	}
}

func TestLiveUnstyledClaudePlaceholderCannotProveEmptyInput(t *testing.T) {
	// Faithful protocol-22 agent.read ANSI snapshot, Claude Code v2.1.288,
	// explicit test session woof-p1-01a0ff95-a / pane w1:p3, 2026-10-03.
	// The UI draws no SGR around its placeholder, making it indistinguishable
	// from a user typing the same words. Idle/readiness cannot override a draft.
	screen, err := os.ReadFile("testdata/claude-live-unstyled-placeholder.ansi")
	if err != nil {
		t.Fatal(err)
	}
	if Inspect("claude", string(screen)) != Typed || Safe("claude", string(screen)) {
		t.Fatal("unstyled placeholder text was treated as proof of an empty editor")
	}
	rule := strings.Repeat("─", 40)
	placeholder := `Try "write a test for <filepath>"`
	for _, content := range []string{placeholder, "actually typed draft", placeholder + " extra draft"} {
		if Safe("claude", rule+"\n❯\u00a0"+content+"\n"+rule) {
			t.Fatalf("normal-style typed content accepted: %q", content)
		}
	}
	if !Safe("claude", rule+"\n❯\u00a0\x1b[2m"+placeholder+"\x1b[0m\n"+rule) {
		t.Fatal("verified dim placeholder was rejected")
	}
	if Safe("claude", rule+"\n❯\u00a0actual draft \x1b[2m"+placeholder+"\x1b[0m\n"+rule) {
		t.Fatal("typed text beside dim placeholder was accepted")
	}
}

func TestNoticeBoundedAndArtifactReferences(t *testing.T) {
	messages := []model.Message{{ID: "m_123", Body: "Please check the failing test.", Artifacts: []model.Artifact{{Path: "/tmp/handoff.md"}}}}
	notice := Notice(messages)
	for _, part := range []string{"m_123", "Please check the failing test.", "/tmp/handoff.md", "woof inbox", "woof message show"} {
		if !strings.Contains(notice, part) {
			t.Fatalf("missing %q in %q", part, notice)
		}
	}
	messages[0].Body = strings.Repeat("界", 10000)
	for i := 0; i < 100; i++ {
		messages = append(messages, messages[0])
	}
	notice = Notice(messages)
	if utf8.RuneCountInString(notice) > 2000 || !utf8.ValidString(notice) || !strings.Contains(notice, "woof inbox") {
		t.Fatal("notice exceeded bound or lost instructions")
	}
}

func TestDispatchShortHandoffAndLogicalReport(t *testing.T) {
	d := model.Dispatch{ID: "d_123", WorkerID: "w_123", AttachmentID: "a_456", Spec: strings.Repeat("Detailed task ", 1000), Handoff: "/tmp/handoff $(touch marker).md"}
	p := Dispatch(d, model.Worker{ID: "w_123", AttachmentID: "a_456", PaneID: "w1:p9"})
	for _, part := range []string{"/tmp/handoff $(touch marker).md", "woof done --dispatch d_123 --attachment a_456", "woof dispatch show", "artifact"} {
		if !strings.Contains(p, part) {
			t.Fatalf("missing %q: %s", part, p)
		}
	}
	if strings.Contains(p, "w1:p9") || utf8.RuneCountInString(p) > 2000 || strings.Contains(p, d.Spec) {
		t.Fatal("dispatch leaked pane identity or whole handoff")
	}
}

func TestDispatchReportingUsesOriginalActorFence(t *testing.T) {
	d := model.Dispatch{ID: "dispatch_original", WorkerID: "worker_original", AttachmentID: "attachment_original", Spec: "finish task"}
	p := Dispatch(d, model.Worker{ID: "worker_replacement", AttachmentID: "attachment_replacement"})
	for _, expected := range []string{"--attachment attachment_original", "--as-worker worker_original --as-attachment attachment_original"} {
		if !strings.Contains(p, expected) {
			t.Fatalf("missing original binding %q: %s", expected, p)
		}
	}
	if strings.Contains(p, "worker_replacement") || strings.Contains(p, "attachment_replacement") {
		t.Fatal("completion prompt substituted a later actor binding")
	}
	d.AttachmentID = ""
	p = Dispatch(d, model.Worker{ID: "worker_replacement", AttachmentID: "attachment_replacement"})
	if strings.Contains(p, "attachment_replacement") || strings.Contains(p, "--as-worker") || strings.Contains(p, "--as-attachment") {
		t.Fatal("missing original binding was completed from a newer worker")
	}
}

func TestNoticeCommandsCarryVerifiedActorAndRemainBounded(t *testing.T) {
	w := model.Worker{ID: "worker_known", AttachmentID: "attachment_original"}
	ms := []model.Message{{ID: "message_known", Kind: "question", Body: strings.Repeat("界", 5000), Artifacts: []model.Artifact{{Path: "/tmp/question.md"}}}}
	p := Notice(ms, w)
	flags := "--as-worker worker_known --as-attachment attachment_original"
	for _, command := range []string{"woof inbox", "woof message show", "woof ack", "woof reply", "woof consume"} {
		at := strings.Index(p, command)
		if at < 0 {
			t.Fatalf("missing command %q: %s", command, p)
		}
		end := strings.Index(p[at:], "`")
		if end < 0 || !strings.Contains(p[at:at+end], flags) {
			t.Fatalf("command %q omitted original actor: %s", command, p)
		}
	}
	if utf8.RuneCountInString(p) > 2000 || !strings.Contains(p, "message_known") || !strings.Contains(p, "/tmp/question.md") {
		t.Fatal("notice exceeded bound or lost durable references")
	}
}

func TestNoticeActorFlagsRequireCompleteBindingAndQuoteLiteralIDs(t *testing.T) {
	for _, w := range []model.Worker{{}, {ID: "worker_known"}, {AttachmentID: "attachment_known"}} {
		if strings.Contains(Notice(nil, w), "--as-worker") || strings.Contains(Notice(nil, w), "--as-attachment") {
			t.Fatal("notice emitted a partial actor identity")
		}
	}
	w := model.Worker{ID: "worker $(touch marker)", AttachmentID: "attachment'quoted"}
	p := Notice(nil, w)
	want := `--as-worker 'worker $(touch marker)' --as-attachment 'attachment'"'"'quoted'`
	if !strings.Contains(p, want) {
		t.Fatalf("actor IDs were not shell quoted literally: %s", p)
	}
	d := model.Dispatch{ID: "dispatch_literal", WorkerID: w.ID, AttachmentID: w.AttachmentID}
	if !strings.Contains(Dispatch(d, w), want) {
		t.Fatal("dispatch and notice actor quoting differ")
	}
}
