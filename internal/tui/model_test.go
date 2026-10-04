package tui

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
)

func key(s string) tea.KeyPressMsg {
	switch s {
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	}
	return tea.KeyPressMsg{Code: []rune(s)[0], Text: s}
}
func TestStableSelectionAcrossReloadAndPaneMove(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "w1", PaneID: "p1"}, {ID: "w2", PaneID: "p2"}}})
	m.move(1)
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "w2", PaneID: "p9"}, {ID: "w1", PaneID: "p1"}}})
	if m.selected[0] != "w2" {
		t.Fatalf("selection moved: %q", m.selected[0])
	}
}
func TestPickerWrapFilterEscape(t *testing.T) {
	p := newPicker("scope", []choice{{ID: "global", Label: "All"}, {ID: "ws1", Label: "界 alpha"}, {ID: "ws2", Label: "Beta"}}, "ws1")
	p.move(1)
	p.move(1)
	if p.selected != "global" {
		t.Fatal("no wrap")
	}
	p.move(-1)
	if p.selected != "ws2" {
		t.Fatal("no reverse wrap")
	}
	p.update(key("/"))
	for _, c := range "Beta" {
		p.update(key(string(c)))
	}
	if len(p.visible()) != 1 {
		t.Fatal("filter did not narrow")
	}
	_, closed := p.update(key("esc"))
	if closed || p.filtering {
		t.Fatal("first escape should clear")
	}
	_, closed = p.update(key("esc"))
	if !closed {
		t.Fatal("second escape should close")
	}
}
func TestResponsiveViewAndHostileContent(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "w1", Name: "界🙂\x1b]52;c;evil\a\r\x1b[2J", Error: strings.Repeat("界", 200)}}})
	for _, size := range [][2]int{{40, 10}, {60, 16}, {99, 24}, {100, 30}, {180, 40}} {
		m.width, m.height = size[0], size[1]
		v := m.View().Content
		if strings.ContainsAny(v, "\x1b\r\a") {
			t.Fatal("unsafe control in view")
		}
		if len(strings.Split(v, "\n")) > size[1] {
			t.Fatal("height overflow")
		}
		for _, line := range strings.Split(v, "\n") {
			if ansi.StringWidth(line) > size[0] {
				t.Fatalf("width overflow %d > %d", ansi.StringWidth(line), size[0])
			}
		}
	}
}
func TestScopeGenerationRejectsOldReadsAndCallbacks(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.generation = 2
	m.Update(loadMsg{generation: 1, snapshot: Snapshot{Workers: []model.Worker{{ID: "old"}}}})
	m.Update(streamMsg{generation: 1, update: StreamUpdate{Err: errors.New("old")}})
	if len(m.snapshot.Workers) != 0 || m.err != nil {
		t.Fatal("old scope changed view")
	}
}
func TestDisconnectRetainsSnapshotDisablesActionsAndRetries(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "w1"}}})
	m.ready.Store(true)
	_, cmd := m.Update(streamMsg{generation: m.generation, update: StreamUpdate{Err: errors.New("offline")}})
	if m.ready.Load() || len(m.snapshot.Workers) != 1 || cmd == nil {
		t.Fatal("disconnect must disable and retain/retry")
	}
	m.Update(loadMsg{generation: m.generation, err: errors.New("still offline")})
	if m.retryDelay > 3*time.Second || m.ready.Load() {
		t.Fatal("retry readiness/backoff")
	}
}
func TestEventRingBoundedAndDeduplicated(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	for i := int64(1); i <= 600; i++ {
		m.addEvent(model.Event{Seq: i})
		m.addEvent(model.Event{Seq: i})
	}
	if len(m.snapshot.Events) != 500 || m.snapshot.Events[0].Seq != 101 {
		t.Fatal("event ring incorrect")
	}
}
func TestQuitWaitsForMutationReceiptAndDuplicateConfirmBlocked(t *testing.T) {
	b := &uiBackend{}
	m := newModel(context.Background(), b, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	a := Action{Kind: "send", To: "worker:w1", Body: "hello"}
	m.review = &a
	_, cmd := m.Update(key("enter"))
	if cmd == nil || !m.busy {
		t.Fatal("confirm did not start")
	}
	_, again := m.Update(key("enter"))
	if again != nil {
		t.Fatal("duplicate submitted")
	}
	_, quit := m.Update(quitRequest{})
	if quit != nil || !m.quitting {
		t.Fatal("quit lost pending receipt")
	}
	msg := cmd()
	_, quit = m.Update(msg)
	if quit == nil || m.result.OperationID != "op1" {
		t.Fatal("receipt not retained on quit")
	}
}

type uiBackend struct{}

func (*uiBackend) Load(context.Context, model.Scope) (Snapshot, error) { return Snapshot{}, nil }
func (*uiBackend) Follow(ctx context.Context, _ model.Scope, _ int64, _ func(StreamUpdate) error) error {
	<-ctx.Done()
	return ctx.Err()
}
func (*uiBackend) Act(ctx context.Context, _ Action) (ActionResult, error) {
	if ctx.Err() != nil {
		return ActionResult{}, ctx.Err()
	}
	return ActionResult{OperationID: "op1", Uncertain: true}, nil
}
func (*uiBackend) Operation(context.Context, string) (model.Operation, error) {
	return model.Operation{}, nil
}
func (*uiBackend) ScheduleDetail(context.Context, model.Scope, string) (ScheduleDetail, error) {
	return ScheduleDetail{}, nil
}

func TestReadStartedBeforeDisconnectCannotRestoreReadiness(t *testing.T) {
	m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
	defer m.cancel()
	cmd := m.load()
	m.connection.mu.Lock()
	m.connection.epoch++
	m.ready.Store(false)
	m.connection.mu.Unlock()
	m.Update(cmd())
	if m.ready.Load() {
		t.Fatal("older successful snapshot erased newer disconnect")
	}
}
func TestMutationReceiptCanBeDrainedAfterCommandReadsIt(t *testing.T) {
	m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	a := Action{Kind: "send", To: "worker:w1", Body: "hello"}
	m.review = &a
	cmd := m.submit()
	msg := cmd().(actionMsg)
	receipt := m.pending.wait()
	if receipt.result.OperationID != msg.result.OperationID {
		t.Fatal("receipt lost after Tea consumed command")
	}
}

func TestHealthyLoadHasNoPollingAndEventsCoalesceRefresh(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	_, cmd := m.Update(loadMsg{generation: m.generation, snapshot: Snapshot{}})
	if cmd != nil {
		t.Fatal("healthy view scheduled periodic reload")
	}
	m.loading = true
	m.Update(streamMsg{generation: m.generation, update: StreamUpdate{Event: &model.Event{Seq: 1}}})
	_, cmd = m.Update(streamMsg{generation: m.generation, update: StreamUpdate{Event: &model.Event{Seq: 2}}})
	if cmd != nil {
		t.Fatal("duplicate refresh scheduled during burst")
	}
	m.Update(refreshMsg{m.generation})
	if !m.dirty {
		t.Fatal("in-flight invalidation lost")
	}
	_, cmd = m.Update(loadMsg{generation: m.generation, snapshot: Snapshot{Cursor: 1, Events: []model.Event{{Seq: 1}}}})
	if cmd == nil || len(m.snapshot.Events) != 2 {
		t.Fatal("in-flight events/refresh lost")
	}
}
func TestEditorQDoesNotQuitAndOpeningInboxDoesNotAcknowledge(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	e := InboxEntry{Message: model.Message{ID: "m1", ToKind: "human", Body: "hello"}, Delivery: model.Delivery{ID: "receipt1", Human: true}}
	m.acceptSnapshot(Snapshot{Inbox: []InboxEntry{e}})
	m.tab = 1
	_, cmd := m.Update(key("enter"))
	if cmd != nil || !m.detail {
		t.Fatal("read sent mutation")
	}
	f := NewForm(Action{Kind: "send", To: "worker:w1"})
	m.form = &f
	m.Update(key("q"))
	if m.quitting {
		t.Fatal("editor q quit program")
	}
	m.Update(key("esc"))
	if m.form != nil || m.quitting {
		t.Fatal("editor escape must cancel")
	}
}
func TestDetailedSettlementReceiptsArtifactsAndLiteralArgs(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "w1"}}, Dispatches: []model.Dispatch{{ID: "d1", WorkerID: "w1", DoneMessageID: "m_report", TurnEnded: false}}, Reports: map[string]MessageDetail{"m_report": {Message: model.Message{Body: "report body"}, Artifacts: []artifacts.FileStatus{{Path: "/missing/report", Error: "missing"}}}}, Inbox: []InboxEntry{{Message: model.Message{ID: "m1", Body: "message body"}, Delivery: model.Delivery{ID: "receipt", Status: "delivered", WakeStatus: "uncertain", AcknowledgedAt: 42}}}, Profiles: []profiles.Summary{{Name: "raw", Agent: "claude"}}, ProfileDetails: map[string]profiles.Profile{"raw": {Args: []string{"literal value", "$(leave literal)"}}}})
	text := m.detailText()
	for _, want := range []string{"Explicit report: m_report", "Corresponding turn ended: false", "report body", "exists:false readable:false", "Worker mailbox (read-only"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q", want)
		}
	}
	m.tab = 1
	text = m.detailText()
	for _, want := range []string{"message body", "wake: uncertain", "acknowledged: 42"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q", want)
		}
	}
	m.tab = 4
	text = m.detailText()
	if !strings.Contains(text, `"literal value"`) || !strings.Contains(text, `"$(leave literal)"`) {
		t.Fatal("profile argv lost literal boundary")
	}
}
func TestScopeCataloguePicksDurableIDAndEnrichesRun(t *testing.T) {
	s := Snapshot{Sessions: []model.Session{{ID: "s1", HerdrName: "same"}}, Workspaces: []model.Workspace{{ID: "ws1", SessionID: "s1", Name: "same"}}, Worktrees: []model.Worktree{{ID: "wt1", WorkspaceID: "ws1", SessionID: "s1"}}, Runs: []model.Run{{ID: "r1", SessionID: "s1", WorkspaceID: "ws1"}}}
	p := newPicker("scope", scopeChoices(s), "r1")
	c, closed := p.update(key("enter"))
	if !closed || c.Scope.RunID != "r1" || c.Scope.WorkspaceID != "ws1" {
		t.Fatal("scope lost canonical identity")
	}
	m := newModel(context.Background(), nil, model.Scope{RunID: "r1"})
	defer m.cancel()
	m.catalogue = s
	if m.browseScope().WorkspaceID != "ws1" {
		t.Fatal("run-only browse did not enrich workspace")
	}
}
func TestUnicodeSafeTextRemovesBidiAndIncompleteEscapes(t *testing.T) {
	got := safeText("日本🙂 e\u0301\x1b[2J\x1b]52;c;x\a\x1b[\r\a\u202eabc")
	if strings.ContainsAny(got, "\x1b\r\a\u202e") || !strings.Contains(got, "日本🙂 e\u0301") {
		t.Fatalf("unsafe or lost unicode: %q", got)
	}
}

func TestLaterSuccessPreservesUncertainOperationForInspectionAndExit(t *testing.T) {
	m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
	defer m.cancel()
	m.Update(actionMsg{result: ActionResult{OperationID: "lost_receipt", Uncertain: true}})
	m.Update(actionMsg{result: ActionResult{OperationID: "later_success"}})
	if len(m.uncertain) != 1 || m.uncertain[0] != "lost_receipt" {
		t.Fatal("uncertain operation lost after later success")
	}
	_, cmd := m.Update(key("i"))
	if cmd == nil {
		t.Fatal("prior uncertain operation no longer inspectable")
	}
}

func TestReviewScrollAndCancelBeforeSubmission(t *testing.T) {
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	a := Action{Kind: "send", To: "worker:w1", Body: strings.Repeat("body\n", 80)}
	m.review = &a
	m.Update(tea.KeyPressMsg{Code: tea.KeyPgDown})
	if m.scroll == 0 {
		t.Fatal("long mandatory review cannot scroll")
	}
	m.Update(key("esc"))
	if m.review != nil || m.busy {
		t.Fatal("cancel submitted review")
	}
}

func TestLateCatalogueDoesNotOverlayNewActionEditor(t *testing.T) {
	m := newModel(context.Background(), &uiBackend{}, model.Scope{Global: true})
	defer m.cancel()
	m.ready.Store(true)
	cmd := m.pickCatalogue("scope")
	m.beginAction(Action{Kind: "send", To: "worker:w1"}, nil)
	m.Update(cmd())
	if m.picker != nil || m.form == nil {
		t.Fatal("late picker obscured the active action editor")
	}
}

func TestReloadKeepsSelectedWorkerInsideActiveFilter(t *testing.T) {
	for _, renamed := range []bool{false, true} {
		t.Run(fmt.Sprint(renamed), func(t *testing.T) {
			m := newModel(context.Background(), nil, model.Scope{Global: true})
			defer m.cancel()
			m.acceptSnapshot(Snapshot{Workers: []model.Worker{{ID: "hidden", Name: "Beta", SessionID: "s1", WorkspaceID: "ws1"}, {ID: "old", Name: "Alpha", SessionID: "s1", WorkspaceID: "ws1"}}})
			m.filter = "Alpha"
			m.ensureSelection()
			workers := []model.Worker{{ID: "hidden", Name: "Beta", SessionID: "s1", WorkspaceID: "ws1"}, {ID: "new", Name: "Alpha2", SessionID: "s1", WorkspaceID: "ws1"}}
			if renamed {
				workers = append(workers, model.Worker{ID: "old", Name: "Beta renamed", SessionID: "s1", WorkspaceID: "ws1"})
			}
			m.acceptSnapshot(Snapshot{Workers: workers})
			if m.selected[0] != "new" {
				t.Fatalf("selected hidden worker %q after filtered reload", m.selected[0])
			}
			m.ready.Store(true)
			m.Update(key("n"))
			if m.form == nil || m.form.action.To != "worker:new" {
				t.Fatal("action targeted a filtered-out worker")
			}
		})
	}
}
func TestPickerSelectedLongRowVisibleAtMinimumSize(t *testing.T) {
	for _, label := range []string{strings.Repeat("long-", 30), strings.Repeat("界🙂", 50)} {
		t.Run(fmt.Sprint(ansi.StringWidth(label)), func(t *testing.T) {
			m := newModel(context.Background(), nil, model.Scope{Global: true})
			defer m.cancel()
			m.width, m.height = 60, 16
			choices := []choice{}
			for i := range 9 {
				id := fmt.Sprintf("choice-%d", i)
				choices = append(choices, choice{ID: id, Label: id + " " + label})
			}
			m.picker = newPicker("Scope", choices, "choice-7")
			view := m.View().Content
			if !strings.Contains(view, "> choice-7") {
				t.Fatalf("selected picker item hidden: %s", view)
			}
			for _, line := range strings.Split(view, "\n") {
				if ansi.StringWidth(line) > 60 {
					t.Fatal("picker overflow")
				}
			}
		})
	}
}

func TestActionReviewShowsArtifactAvailability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-report.txt")
	text := reviewText(Action{Kind: "send", To: "worker:w1", Body: "body", Artifacts: []string{path}})
	if !strings.Contains(text, path+" [missing]") {
		t.Fatalf("review omitted artifact availability: %s", text)
	}
}
