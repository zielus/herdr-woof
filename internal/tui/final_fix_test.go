package tui

import (
	tea "charm.land/bubbletea/v2"
	"context"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"strings"
	"testing"
)

func TestHelpOwnsActionAndConfirmationKeys(t *testing.T) {
	for _, actionKey := range []string{"a", "x"} {
		t.Run(actionKey, func(t *testing.T) {
			m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
			defer m.cancel()
			m.ready.Store(true)
			m.tab = 1
			m.acceptSnapshot(Snapshot{Inbox: []InboxEntry{{Message: model.Message{ID: "m1"}, Delivery: model.Delivery{ID: "dl1", MessageID: "m1", Human: true}}}})
			m.Update(key("?"))
			m.Update(key(actionKey))
			_, cmd := m.Update(key("enter"))
			if cmd != nil || m.review != nil || m.busy {
				t.Fatal("help accepted hidden receipt mutation")
			}
			m.Update(key("esc"))
			m.Update(key(actionKey))
			if m.review == nil || !strings.Contains(m.View().Content, "Review ") {
				t.Fatal("visible review unavailable after help dismissal")
			}
		})
	}
}
func TestTinyReviewSuspendsConfirmationPreservesDraftAndCanQuit(t *testing.T) {
	m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	a := Action{Kind: "send", To: "worker:w1", Body: "frozen draft"}
	m.review = &a
	m.Update(tea.WindowSizeMsg{Width: 40, Height: 10})
	_, cmd := m.Update(key("enter"))
	if cmd != nil || m.busy || m.review == nil {
		t.Fatal("tiny notice confirmed or lost draft")
	}
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	if !strings.Contains(m.View().Content, "frozen draft") {
		t.Fatal("draft lost after resize")
	}
	_, cmd = m.Update(key("enter"))
	if cmd == nil || !m.busy {
		t.Fatal("visible review could not confirm")
	}
	m.Update(cmd())
	m.review = &a
	m.Update(tea.WindowSizeMsg{Width: 40, Height: 10})
	_, cmd = m.Update(key("q"))
	if cmd == nil || !m.quitting {
		t.Fatal("tiny review cannot quit")
	}
}
func TestNarrowGateDetailForResolvedAndStaleOpen(t *testing.T) {
	for _, status := range []string{"resolved", "open"} {
		t.Run(status, func(t *testing.T) {
			m := newModel(context.Background(), nil, model.Scope{Global: true})
			defer m.cancel()
			m.width, m.height = 80, 24
			m.tab = 2
			m.ready.Store(status == "resolved")
			m.acceptSnapshot(Snapshot{Gates: []model.Gate{{ID: "g1", Question: "Should we ship?", Status: status, Decision: "approve"}}})
			m.Update(key("enter"))
			if !m.detail || !strings.Contains(m.View().Content, "Decision: approve") {
				t.Fatalf("read-only gate detail unavailable; notice=%q", m.notice)
			}
		})
	}
}
func TestGateReviewIncludesFullFrozenQuestion(t *testing.T) {
	question := "Question starts\n" + strings.Repeat("middle\n", 30) + "Question ends"
	text := reviewText(Action{Kind: "gate.resolve", ID: "g1", Label: question, Decision: "approve"})
	if !strings.Contains(text, question) {
		t.Fatal("review omitted frozen full question")
	}
}

func TestHelpScrollKeysRemainAvailableAtMinimumSize(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.width, m.height = 60, 16
	m.help = true
	m.Update(tea.KeyPressMsg{Code: tea.KeyPgDown})
	if m.scroll == 0 || !m.help || m.review != nil {
		t.Fatal("help does not scroll safely")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyPgUp})
	if m.scroll != 0 {
		t.Fatal("help does not scroll back")
	}
}
