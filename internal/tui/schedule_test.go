package tui

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"
	"github.com/zielus/herdr-woof-v2/internal/client"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/paths"
)

func testSchedule(id, name string, enabled bool) model.Schedule {
	sc := model.Schedule{ID: id, Name: name, SessionID: "session_a", WorkspaceID: "workspace_a", WorkerID: "worker_a", TargetName: "alice", Cron: "0 9 * * MON-FRI", Timezone: "Europe/Warsaw", Missed: "latest", Action: "message", Body: "Prepare the brief", Enabled: enabled, State: "active"}
	if enabled {
		sc.NextRunAt = 1790000000000
		sc.NextRunLocal = "2026-10-05T09:00:00+02:00"
	}
	return sc
}

// scheduleBackend records schedule detail reads and submitted actions.
type scheduleBackend struct {
	uiBackend
	mu      sync.Mutex
	reads   []string
	actions []Action
	result  ActionResult
	err     error
}

func (b *scheduleBackend) ScheduleDetail(_ context.Context, _ model.Scope, id string) (ScheduleDetail, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reads = append(b.reads, id)
	return ScheduleDetail{Schedule: model.Schedule{ID: id}}, nil
}
func (b *scheduleBackend) Act(_ context.Context, a Action) (ActionResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.actions = append(b.actions, a)
	return b.result, b.err
}
func (b *scheduleBackend) actionCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.actions)
}

func scheduleModel(t *testing.T, b Backend) *uiModel {
	t.Helper()
	m := newModel(context.Background(), b, model.Scope{Global: true})
	t.Cleanup(m.cancel)
	m.width, m.height = 80, 24
	m.acceptSnapshot(Snapshot{
		Schedules:    []model.Schedule{testSchedule("sched_a", "alpha brief", true), testSchedule("sched_b", "beta review", false)},
		ScheduleLast: map[string]ScheduleRunView{"sched_a": {Run: model.ScheduleRun{ID: "srun_1", State: "persisted"}}},
	})
	return m
}

func TestScheduleTabKeySixAppendsWithoutMovingExistingTabs(t *testing.T) {
	m := scheduleModel(t, nil)
	for want, k := range []string{"1", "2", "3", "4", "5", "6"} {
		m.Update(key(k))
		if m.tab != want {
			t.Fatalf("key %s selected tab %d, want %d", k, m.tab, want)
		}
	}
	if tabNames[4] != "Profiles" || tabNames[scheduleTab] != "Schedules" {
		t.Fatalf("tab order changed: %v", tabNames)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.tab != 0 {
		t.Fatalf("tab did not wrap from Schedules: %d", m.tab)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	if m.tab != scheduleTab {
		t.Fatalf("shift+tab did not wrap to Schedules: %d", m.tab)
	}
	if m.selected[scheduleTab] != "sched_a" {
		t.Fatalf("schedule selection %q", m.selected[scheduleTab])
	}
}

func TestScheduleRowsShowStateActionTargetNextAndLast(t *testing.T) {
	m := scheduleModel(t, nil)
	rows := m.rowsFor(scheduleTab)
	if len(rows) != 2 || rows[0].ID != "sched_a" || rows[1].ID != "sched_b" {
		t.Fatalf("rows keyed by schedule ID: %+v", rows)
	}
	for _, want := range []string{"alpha brief", "[enabled]", "message→alice", "next:2026-10-05T09:00:00+02:00", "last:persisted", "sched_a"} {
		if !strings.Contains(rows[0].Label, want) {
			t.Fatalf("row %q missing %q", rows[0].Label, want)
		}
	}
	for _, want := range []string{"[disabled]", "next:disabled", "last:none"} {
		if !strings.Contains(rows[1].Label, want) {
			t.Fatalf("row %q missing %q", rows[1].Label, want)
		}
	}
}

func TestScheduleSelectionByIDSurvivesReorderFilterAndRemoval(t *testing.T) {
	m := scheduleModel(t, nil)
	m.Update(key("6"))
	m.move(1)
	if m.selected[scheduleTab] != "sched_b" {
		t.Fatal("move did not select second schedule")
	}
	m.acceptSnapshot(Snapshot{Schedules: []model.Schedule{testSchedule("sched_c", "gamma", true), testSchedule("sched_b", "beta review", true), testSchedule("sched_a", "alpha brief", true)}})
	if m.selected[scheduleTab] != "sched_b" {
		t.Fatalf("reorder moved selection to %q", m.selected[scheduleTab])
	}
	m.Update(key("/"))
	for _, c := range "gamma" {
		m.Update(key(string(c)))
	}
	m.Update(key("enter"))
	if m.selected[scheduleTab] != "sched_c" || len(m.rows()) != 1 {
		t.Fatalf("filter selection %q rows %d", m.selected[scheduleTab], len(m.rows()))
	}
	// A removed schedule is absent from schedule.list; selection falls back
	// within the filtered rows, never to a hidden schedule.
	m.acceptSnapshot(Snapshot{Schedules: []model.Schedule{testSchedule("sched_b", "beta review", true), testSchedule("sched_d", "gamma two", true)}})
	if m.selected[scheduleTab] != "sched_d" {
		t.Fatalf("removed selection fell back to %q", m.selected[scheduleTab])
	}
	m.ready.Store(true)
	m.Update(key("e"))
	if m.review == nil || m.review.ID != "sched_d" {
		t.Fatal("action targeted a filtered-out schedule")
	}
}

func TestScheduleActionsReviewEachKindAndSubmitOnce(t *testing.T) {
	for _, tc := range []struct{ key, kind, verb string }{{"e", "schedule.enable", "Enable"}, {"d", "schedule.disable", "Disable"}, {"u", "schedule.run", "Run now"}} {
		t.Run(tc.kind, func(t *testing.T) {
			b := &scheduleBackend{}
			m := scheduleModel(t, b)
			m.width, m.height = 80, 24
			m.Update(key("6"))
			m.Update(key(tc.key))
			if m.review != nil {
				t.Fatal("stale view opened a schedule review")
			}
			m.ready.Store(true)
			m.Update(key(tc.key))
			if m.review == nil || m.form != nil || m.review.Kind != tc.kind || m.review.ID != "sched_a" {
				t.Fatalf("review not opened: %+v", m.review)
			}
			if m.review.Scope != (model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a"}) {
				t.Fatalf("frozen scope %+v", m.review.Scope)
			}
			view := m.View().Content
			text := reviewText(*m.review)
			for _, want := range []string{"Review " + tc.verb + " schedule", "Schedule: alpha brief", "ID: sched_a", "Action: message", "Target: worker:worker_a (alice)", "never resent"} {
				if !strings.Contains(text, want) {
					t.Fatalf("review missing %q:\n%s", want, text)
				}
			}
			if !strings.Contains(view, "Review "+tc.verb) {
				t.Fatalf("review not visible:\n%s", view)
			}
			_, cmd := m.Update(key("enter"))
			if cmd == nil || !m.busy {
				t.Fatal("confirmation did not submit")
			}
			// The review closed on submit; a second Enter only opens read-only
			// detail (and its side-effect-free schedule.show), never a resend.
			if _, again := m.Update(key("enter")); again != nil {
				if _, ok := again().(scheduleDetailMsg); !ok || m.review != nil {
					t.Fatal("duplicate confirmation submitted")
				}
			}
			if _, again := m.Update(key(tc.key)); again != nil || m.review != nil {
				t.Fatal("second schedule action opened while submitting")
			}
			msg := cmd().(actionMsg)
			if msg.kind != tc.kind || b.actionCount() != 1 {
				t.Fatalf("submitted %d actions, kind %q", b.actionCount(), msg.kind)
			}
		})
	}
}

func TestScheduleEscCancelsReviewWithoutMutation(t *testing.T) {
	b := &scheduleBackend{}
	m := scheduleModel(t, b)
	m.ready.Store(true)
	m.Update(key("6"))
	m.Update(key("u"))
	m.Update(key("esc"))
	if m.review != nil || m.busy || b.actionCount() != 0 {
		t.Fatal("cancelled review mutated")
	}
}

func TestScheduleUncertainOutcomeIsInspectableAndNeverRetried(t *testing.T) {
	b := &scheduleBackend{result: ActionResult{OperationID: "op_lost", Uncertain: true}, err: &model.Error{Code: "outcome_unknown", OperationID: "op_lost", Message: "lost"}}
	m := scheduleModel(t, b)
	m.ready.Store(true)
	m.Update(key("6"))
	m.Update(key("u"))
	_, cmd := m.Update(key("enter"))
	_, next := m.Update(cmd())
	if len(m.uncertain) != 1 || m.uncertain[0] != "op_lost" || !strings.Contains(m.notice, "op_lost") {
		t.Fatalf("uncertain operation hidden: %v %q", m.uncertain, m.notice)
	}
	if next == nil {
		t.Fatal("no canonical reload after outcome")
	}
	if b.actionCount() != 1 || m.busy || m.review != nil {
		t.Fatalf("uncertain mutation resent: %d", b.actionCount())
	}
	// Run-now whose dispatch prompt outcome is unknown: definite RPC, uncertain occurrence.
	raw, err := json.Marshal(model.ScheduleRun{ID: "srun_u", State: "uncertain", AttemptID: "op_attempt"})
	if err != nil {
		t.Fatal(err)
	}
	m.Update(actionMsg{kind: "schedule.run", result: ActionResult{Value: raw, OperationID: "op_attempt", Uncertain: true}})
	if len(m.uncertain) != 2 || !strings.Contains(m.notice, "never resent") || !strings.Contains(m.notice, "op_attempt") || !strings.Contains(m.notice, "srun_u") {
		t.Fatalf("uncertain run notice %q %v", m.notice, m.uncertain)
	}
	if b.actionCount() != 1 {
		t.Fatal("uncertain run resent")
	}
}

func TestScheduleRunNoticesKeepPersistenceDispatchAndSettlementDistinct(t *testing.T) {
	for _, tc := range []struct {
		run  model.ScheduleRun
		want string
	}{
		{model.ScheduleRun{ID: "srun_p", State: "persisted", MessageID: "msg_1"}, "not completed work"},
		{model.ScheduleRun{ID: "srun_d", State: "dispatched", DispatchID: "disp_1"}, "settlement shown separately"},
		{model.ScheduleRun{ID: "srun_b", State: "blocked", Reason: "worker_busy"}, "nothing sent"},
		{model.ScheduleRun{ID: "srun_f", State: "failed", Error: "refused"}, "failed: refused"},
		{model.ScheduleRun{ID: "srun_s", State: "settled", Reason: "done"}, "settled (done)"},
	} {
		raw, err := json.Marshal(tc.run)
		if err != nil {
			t.Fatal(err)
		}
		if got := scheduleActionNotice("schedule.run", raw); !strings.Contains(got, tc.want) || !strings.Contains(got, tc.run.ID) {
			t.Fatalf("notice %q missing %q", got, tc.want)
		}
	}
	raw, err := json.Marshal(testSchedule("sched_a", "alpha", false))
	if err != nil {
		t.Fatal(err)
	}
	if got := scheduleActionNotice("schedule.disable", raw); !strings.Contains(got, "disabled") {
		t.Fatalf("disable notice %q", got)
	}
}

func TestScheduleDetailFencesStaleScopeIDAndRequest(t *testing.T) {
	b := &scheduleBackend{}
	m := scheduleModel(t, b)
	m.width, m.height = 120, 30
	_, cmd := m.Update(key("6"))
	if cmd == nil || m.scheduleDetailState != "loading" || m.scheduleDetailID != "sched_a" {
		t.Fatalf("visible schedule detail not requested: %q %q", m.scheduleDetailState, m.scheduleDetailID)
	}
	good := cmd().(scheduleDetailMsg)
	if good.id != "sched_a" || len(b.reads) != 1 {
		t.Fatalf("read %+v", b.reads)
	}
	for name, stale := range map[string]scheduleDetailMsg{
		"old generation": {generation: good.generation - 1, request: good.request, id: good.id},
		"other schedule": {generation: good.generation, request: good.request, id: "sched_b"},
		"old request":    {generation: good.generation, request: good.request - 1, id: good.id},
	} {
		stale.detail = ScheduleDetail{Schedule: model.Schedule{ID: stale.id}, Upcoming: []ScheduleOccurrence{{Local: "stale " + name}}}
		m.Update(stale)
		if m.scheduleDetail != nil || m.scheduleDetailState != "loading" {
			t.Fatalf("%s result accepted", name)
		}
	}
	good.detail.Upcoming = []ScheduleOccurrence{{Local: "2026-10-05T09:00:00+02:00"}}
	m.Update(good)
	if m.scheduleDetail == nil || m.scheduleDetailState != "done" || !strings.Contains(m.detailText(), "1. 2026-10-05T09:00:00+02:00") {
		t.Fatal("current result rejected")
	}
	// A scope change discards the old detail and fences its in-flight reads.
	old := good
	m.setScope(model.Scope{SessionID: "session_b"})
	m.Update(old)
	if m.scheduleDetail != nil {
		t.Fatal("old scope detail accepted after scope change")
	}
}

func TestScheduleDetailReadsOncePerReloadWithoutPolling(t *testing.T) {
	b := &scheduleBackend{}
	m := scheduleModel(t, b)
	m.width, m.height = 120, 30
	_, cmd := m.Update(key("6"))
	m.Update(cmd())
	request := m.scheduleDetailRequest
	for _, k := range []string{"?", "?", "r"} {
		_, c := m.Update(key(k))
		_ = c
	}
	if m.scheduleDetailRequest != request || len(b.reads) != 1 {
		t.Fatalf("detail refetched without reload: %d reads", len(b.reads))
	}
	m.Update(streamMsg{generation: m.generation, update: StreamUpdate{Event: &model.Event{Seq: 9, Type: "schedule.run.persisted"}}})
	if m.scheduleDetailState != "stale" || !strings.Contains(m.detailText(), "refreshing") {
		t.Fatalf("schedule event did not mark detail stale: %q", m.scheduleDetailState)
	}
	m.loading = true
	m.Update(loadMsg{generation: m.generation, snapshot: Snapshot{Cursor: 9, Schedules: m.snapshot.Schedules}})
	if m.scheduleDetailState != "loading" || m.scheduleDetailRequest <= request {
		t.Fatalf("reload did not invalidate detail: %q", m.scheduleDetailState)
	}
	// A failed read is shown and waits for the next reload rather than polling.
	m.Update(scheduleDetailMsg{generation: m.generation, request: m.scheduleDetailRequest, id: "sched_a", err: errors.New("detail offline")})
	failed := m.scheduleDetailRequest
	m.Update(key("?"))
	m.Update(key("?"))
	if m.scheduleDetailRequest != failed || !strings.Contains(m.detailText(), "Detail unavailable: detail offline") {
		t.Fatal("failed detail read was retried without reload")
	}
	// Narrow list without detail does not read; Enter opens and reads.
	n := scheduleModel(t, b)
	n.width, n.height = 80, 24
	if _, c := n.Update(key("6")); c != nil || n.scheduleDetailState != "" {
		t.Fatal("hidden narrow detail was read")
	}
	if _, c := n.Update(key("enter")); c == nil || !n.detail || n.scheduleDetailState != "loading" {
		t.Fatal("opened narrow detail was not read")
	}
}

func TestScheduleDetailExplainsRunsUpcomingAndCLIOnlyAddRemove(t *testing.T) {
	m := scheduleModel(t, nil)
	m.tab = scheduleTab
	turnEnd := false
	m.scheduleDetailID = "sched_a"
	m.scheduleDetailState = "done"
	m.scheduleDetail = &ScheduleDetail{
		Schedule: model.Schedule{ID: "sched_a"},
		Upcoming: []ScheduleOccurrence{{Local: "U1"}, {Local: "U2"}, {Local: "U3"}, {Local: "U4"}, {Local: "U5"}},
		Runs: []ScheduleRunView{
			{Run: model.ScheduleRun{ID: "srun_p", State: "persisted", Trigger: "scheduled", ScheduledForLocal: "2026-10-02T09:00:00+02:00", MessageID: "msg_1"}, Deliveries: []model.Delivery{{ID: "dl_1", Status: "delivered", WakeStatus: "deferred"}}},
			{Run: model.ScheduleRun{ID: "srun_d", State: "dispatched", Trigger: "manual", DispatchID: "disp_1"}, Dispatch: &model.Dispatch{ID: "disp_1", Status: "active", TurnEnded: turnEnd}},
			{Run: model.ScheduleRun{ID: "srun_u", State: "uncertain", Trigger: "scheduled", AttemptID: "op_attempt"}, Operation: &model.Operation{ID: "op_attempt", State: "uncertain"}},
			{Run: model.ScheduleRun{ID: "srun_b", State: "blocked", Reason: "worker_busy", SkippedCount: 3, SkippedLast: 1790000000000}},
			{Run: model.ScheduleRun{ID: "srun_s", State: "settled", Reason: "done", DispatchID: "disp_0"}, Dispatch: &model.Dispatch{ID: "disp_0", Status: "settled", TurnEnded: true, DoneMessageID: "msg_done", Outcome: "done"}},
		},
	}
	text := m.detailText()
	for _, want := range []string{
		"Schedule alpha brief [enabled]", "ID: sched_a", "Session: session_a", "Workspace: workspace_a", "Target worker: worker_a (alice", "Cron: 0 9 * * MON-FRI", "Timezone: Europe/Warsaw", "Missed policy: latest", "Action: message", "Prepare the brief", "Next run: 2026-10-05T09:00:00+02:00",
		"1. U1", "5. U5",
		"Occurrence srun_p [persisted] trigger:scheduled", "message queued", "not completed work", "Scheduled for: 2026-10-02T09:00:00+02:00", "Delivery dl_1: delivered  wake:deferred",
		"Occurrence srun_d [dispatched]", "settlement", "Dispatch disp_1 [active]", "turn ended:false",
		"Occurrence srun_u [uncertain]", "never resent", "woof operation show --id op_attempt",
		"Reason: worker_busy", "Skipped while outstanding: 3 (last due 2026-09-21T", "nothing queued",
		"Occurrence srun_s [settled]", "done report AND matching turn-end evidence", "Reason: done", "turn ended:true",
		"CLI only",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("detail missing %q:\n%s", want, text)
		}
	}
	m.width, m.height = 200, 60
	m.Update(key("?"))
	help := m.View().Content
	if !strings.Contains(help, "Schedules (6)") || !strings.Contains(help, "CLI-only") || !strings.Contains(help, "u run now") {
		t.Fatalf("help lacks schedule keys: %s", help)
	}
}

func TestScheduleViewNarrowWideAndPlainLabels(t *testing.T) {
	for _, tc := range []struct {
		name, term, noColor string
		profile             colorprofile.Profile
		colors              bool
	}{
		{"no-color", "xterm-256color", "1", colorprofile.TrueColor, false},
		{"ascii", "xterm-256color", "", colorprofile.Ascii, false},
		{"dumb", "dumb", "", colorprofile.TrueColor, false},
		{"color", "xterm-256color", "", colorprofile.ANSI256, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NO_COLOR", tc.noColor)
			t.Setenv("TERM", tc.term)
			checkScheduleView(t, tc.profile, tc.colors)
		})
	}
}
func checkScheduleView(t *testing.T, profile colorprofile.Profile, colors bool) {
	t.Helper()
	m := scheduleModel(t, nil)
	m.acceptSnapshot(Snapshot{Schedules: []model.Schedule{testSchedule("sched_a", "界🙂\x1b]52;c;evil\a\r"+strings.Repeat("long", 40), true), testSchedule("sched_b", "beta", false)}})
	m.Update(tea.ColorProfileMsg{Profile: profile})
	if m.colors != colors {
		t.Fatalf("styling %t, want %t", m.colors, colors)
	}
	m.Update(key("6"))
	m.scheduleDetailID, m.scheduleDetailState = "sched_a", "done"
	m.scheduleDetail = &ScheduleDetail{Schedule: model.Schedule{ID: "sched_a"}, Runs: []ScheduleRunView{{Run: model.ScheduleRun{ID: "srun_u", State: "uncertain", AttemptID: "op_attempt"}}}}
	for _, size := range [][2]int{{60, 16}, {80, 24}, {99, 24}, {100, 30}, {180, 40}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		view := m.View().Content
		if strings.ContainsAny(view, "\r\a") || (!colors && strings.Contains(view, "\x1b")) || strings.Contains(view, "]52;") {
			t.Fatalf("styling/control in view at %v", size)
		}
		if colors {
			view = ansi.Strip(view)
		}
		lines := strings.Split(view, "\n")
		if len(lines) > size[1] {
			t.Fatalf("height overflow at %v", size)
		}
		for _, line := range lines {
			if ansi.StringWidth(line) > size[0] {
				t.Fatalf("width overflow %d > %d", ansi.StringWidth(line), size[0])
			}
		}
		if !strings.Contains(view, "[6 Schedules]") || !strings.Contains(view, "> ") || !strings.Contains(view, "1–6/Tab") {
			t.Fatalf("active tab, selection marker or keys hidden at %v:\n%s", size, view)
		}
		if !strings.Contains(view, "[disabled]") {
			t.Fatalf("plain state label hidden at %v:\n%s", size, view)
		}
	}
	m.Update(tea.WindowSizeMsg{Width: 180, Height: 40})
	if view := ansi.Strip(m.View().Content); !strings.Contains(view, "1 Workers") || !strings.Contains(view, "Occurrence srun_u [uncertain]") || !strings.Contains(view, "Cron: 0 9 * * MON-FRI") {
		t.Fatalf("wide header or schedule detail lost text:\n%s", view)
	}
}

// Backend adapter: schedule list/history in Load, optional on older daemons.

func TestRPCBackendLoadSchedulesAndLatestOccurrence(t *testing.T) {
	var mu sync.Mutex
	args := map[string]json.RawMessage{}
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		mu.Lock()
		args[r.Op] = r.Args
		mu.Unlock()
		switch r.Op {
		case "events.tail":
			streamReply(t, c, model.EventTail{EventCursor: 3, Events: []model.Event{}})
		case "schedule.list":
			streamReply(t, c, []model.Schedule{testSchedule("sched_a", "alpha", true), testSchedule("sched_b", "beta", false)})
		case "schedule.history":
			var a struct {
				ID    string `json:"id"`
				Limit int    `json:"limit"`
			}
			if err := json.Unmarshal(r.Args, &a); err != nil || a.Limit != 1 {
				t.Errorf("history args %s", r.Args)
			}
			if r.ID != "" {
				t.Error("read carried a mutation request ID")
			}
			if a.ID == "sched_a" {
				streamReply(t, c, []ScheduleRunView{{Run: model.ScheduleRun{ID: "srun_1", State: "dispatched"}, Dispatch: &model.Dispatch{ID: "disp_1"}}})
				return
			}
			streamReply(t, c, []ScheduleRunView{})
		default:
			streamReply(t, c, []any{})
		}
	})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	snap, err := b.Load(ctx, model.Scope{WorkspaceID: "workspace_a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Schedules) != 2 || snap.ScheduleLast["sched_a"].Run.State != "dispatched" || snap.ScheduleLast["sched_a"].Dispatch == nil {
		t.Fatalf("schedules %+v last %+v", snap.Schedules, snap.ScheduleLast)
	}
	if _, ok := snap.ScheduleLast["sched_b"]; ok || snap.Errors["schedules"] != "" {
		t.Fatalf("unexpected last/error %+v %+v", snap.ScheduleLast, snap.Errors)
	}
	mu.Lock()
	defer mu.Unlock()
	if string(args["schedule.list"]) != `{"all":false}` {
		t.Fatalf("list args %s", args["schedule.list"])
	}
}

func TestRPCBackendScheduleListFailureLeavesMonitorUsable(t *testing.T) {
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		switch r.Op {
		case "events.tail":
			streamReply(t, c, model.EventTail{EventCursor: 4, Events: []model.Event{}})
		case "worker.list":
			streamReply(t, c, []model.Worker{{ID: "w_a"}})
		case "schedule.list":
			if err := json.NewEncoder(c).Encode(model.Response{Version: model.Protocol, Error: &model.Error{Code: "unknown_operation", Message: "schedule.list"}}); err != nil {
				t.Error(err)
			}
		default:
			streamReply(t, c, []any{})
		}
	})
	b := &RPCBackend{Base: &client.Client{Paths: p}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	snap, err := b.Load(ctx, model.Scope{Global: true})
	if err != nil || len(snap.Workers) != 1 || snap.Cursor != 4 || len(snap.Schedules) != 0 {
		t.Fatalf("older daemon blanked monitor: %+v %v", snap, err)
	}
	if !strings.Contains(snap.Errors["schedules"], "unknown_operation") {
		t.Fatalf("schedule error hidden: %+v", snap.Errors)
	}
	m := newModel(context.Background(), nil, model.Scope{Global: true})
	defer m.cancel()
	m.acceptSnapshot(snap)
	m.tab = scheduleTab
	if !strings.Contains(m.View().Content, "schedules: unknown_operation") {
		t.Fatal("schedule section error not displayed")
	}
}

func TestRPCBackendScheduleDetailIsScopedHumanRead(t *testing.T) {
	requests := make(chan model.Request, 1)
	p := streamFixture(t, func(c net.Conn, r model.Request) {
		requests <- r
		streamReply(t, c, map[string]any{"schedule": testSchedule("sched_a", "alpha", true), "upcoming": []ScheduleOccurrence{{At: 1, Local: "L1"}}, "runs": []ScheduleRunView{{Run: model.ScheduleRun{ID: "srun_1", State: "persisted"}}}})
	})
	b := &RPCBackend{Base: &client.Client{Paths: p, Caller: model.Caller{WorkerID: "w_stale", PaneID: "w:p"}, Scope: model.Scope{WorkerID: "w_stale"}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	detail, err := b.ScheduleDetail(ctx, model.Scope{SessionID: "session_a"}, "sched_a")
	if err != nil || detail.Schedule.ID != "sched_a" || len(detail.Upcoming) != 1 || detail.Runs[0].Run.State != "persisted" {
		t.Fatalf("detail %+v %v", detail, err)
	}
	r := <-requests
	if r.Op != "schedule.show" || r.ID != "" || r.Scope != (model.Scope{SessionID: "session_a"}) || !r.ScopeExplicit || r.Caller.WorkerID != "" || r.Caller.PaneID != "" || string(r.Args) != `{"id":"sched_a"}` {
		t.Fatalf("detail request %+v args %s", r, r.Args)
	}
}

// Actions against a real daemon and a faulty transport.

func TestActionDaemonScheduleEnableDisableRunNow(t *testing.T) {
	b, human, _, _ := actionDaemon(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	scoped := *human
	scoped.Scope = model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a"}
	var sc model.Schedule
	if err := scoped.Call(ctx, "schedule.add", map[string]any{"name": "brief", "to": "Builder", "cron": "@hourly", "body": "Prepare"}, &sc); err != nil {
		t.Fatal(err)
	}
	act := func(kind string, s model.Schedule) ActionResult {
		t.Helper()
		a, err := NewScheduleAction(kind, s)
		if err != nil {
			t.Fatal(err)
		}
		result, err := b.Act(ctx, a)
		if err != nil || result.Uncertain {
			t.Fatalf("%s: %+v %v", kind, result, err)
		}
		return result
	}
	var got model.Schedule
	if err := json.Unmarshal(act("schedule.disable", sc).Value, &got); err != nil || got.Enabled || got.NextRunAt != 0 {
		t.Fatalf("disable %+v %v", got, err)
	}
	if err := json.Unmarshal(act("schedule.enable", sc).Value, &got); err != nil || !got.Enabled || got.NextRunLocal == "" {
		t.Fatalf("enable %+v %v", got, err)
	}
	var run model.ScheduleRun
	if err := json.Unmarshal(act("schedule.run", sc).Value, &run); err != nil || run.State != "persisted" || run.Trigger != "manual" || run.MessageID == "" {
		t.Fatalf("run now %+v %v", run, err)
	}
	var history []ScheduleRunView
	if err := human.Call(ctx, "schedule.history", map[string]any{"id": sc.ID, "limit": 10}, &history); err != nil || len(history) != 1 || history[0].Message == nil {
		t.Fatalf("history after one run now: %+v %v", history, err)
	}
	// Real daemon read round trip through the TUI adapter.
	workspace := model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a"}
	snap, err := b.Load(ctx, workspace)
	if err != nil || len(snap.Schedules) != 1 || snap.Schedules[0].ID != sc.ID || snap.ScheduleLast[sc.ID].Run.State != "persisted" || snap.Errors["schedules"] != "" {
		t.Fatalf("scoped load: %+v last %+v errors %+v %v", snap.Schedules, snap.ScheduleLast, snap.Errors, err)
	}
	detail, err := b.ScheduleDetail(ctx, workspace, sc.ID)
	if err != nil || detail.Schedule.ID != sc.ID || len(detail.Upcoming) != 5 || len(detail.Runs) != 1 || detail.Runs[0].Message == nil {
		t.Fatalf("detail: %+v %v", detail, err)
	}
	for _, scope := range []model.Scope{{Global: true}, {WorktreeID: "tree_a"}, {RunID: "run_a"}} {
		snap, err := b.Load(ctx, scope)
		if err != nil || snap.Errors["schedules"] != "" || len(snap.Schedules) != 1 {
			t.Fatalf("%+v load: %d schedules %+v %v", scope, len(snap.Schedules), snap.Errors, err)
		}
		if detail, err := b.ScheduleDetail(ctx, scope, sc.ID); err != nil || detail.Schedule.ID != sc.ID {
			t.Fatalf("%+v detail: %v", scope, err)
		}
	}
	// Drifted scope and removed schedules are refused before mutation.
	drift, err := NewScheduleAction("schedule.run", sc)
	if err != nil {
		t.Fatal(err)
	}
	drift.Scope.WorkspaceID = "workspace_other"
	if _, err := b.Act(ctx, drift); err == nil || !strings.Contains(err.Error(), "scope changed") {
		t.Fatalf("drifted schedule scope accepted: %v", err)
	}
	if err := scoped.Call(ctx, "schedule.remove", map[string]any{"id": sc.ID}, nil); err != nil {
		t.Fatal(err)
	}
	removed, err := NewScheduleAction("schedule.enable", sc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Act(ctx, removed); err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("removed schedule mutated: %v", err)
	}
	if err := human.Call(ctx, "schedule.history", map[string]any{"id": sc.ID, "limit": 10}, &history); err != nil || len(history) != 1 {
		t.Fatalf("refused actions changed history: %+v %v", history, err)
	}
}

func TestScheduleActionUncertaintyPreservesOperationAndNeverResends(t *testing.T) {
	for _, mode := range []string{"drop", "uncertain", "run-uncertain"} {
		t.Run(mode, func(t *testing.T) {
			dir, err := os.MkdirTemp("/tmp", "woof-sfault-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(dir); err != nil {
					t.Error(err)
				}
			})
			sock := filepath.Join(dir, "daemon.sock")
			ln, err := net.Listen("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			var mutations atomic.Int32
			mutation := make(chan model.Request, 4)
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					conn, err := ln.Accept()
					if err != nil {
						return
					}
					var req model.Request
					if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&req); err == nil {
						switch req.Op {
						case "schedule.show":
							raw, _ := json.Marshal(ScheduleDetail{Schedule: testSchedule("sched_a", "alpha", true)})
							if err := json.NewEncoder(conn).Encode(model.Response{Version: model.Protocol, OK: true, Result: raw}); err != nil {
								t.Error(err)
							}
						case "schedule.run":
							mutations.Add(1)
							mutation <- req
							switch mode {
							case "uncertain":
								if err := json.NewEncoder(conn).Encode(model.Response{Version: model.Protocol, Error: &model.Error{Code: "uncertain", OperationID: req.ID, Message: "inspect receipt"}}); err != nil {
									t.Error(err)
								}
							case "run-uncertain":
								raw, _ := json.Marshal(model.ScheduleRun{ID: "srun_u", State: "uncertain", AttemptID: "op_attempt"})
								if err := json.NewEncoder(conn).Encode(model.Response{Version: model.Protocol, OK: true, Result: raw}); err != nil {
									t.Error(err)
								}
							}
						}
					}
					if err := conn.Close(); err != nil {
						t.Error(err)
					}
				}
			}()
			t.Cleanup(func() {
				if err := ln.Close(); err != nil {
					t.Error(err)
				}
				<-done
			})
			b := RPCBackend{Base: &client.Client{Paths: paths.Paths{Sock: sock}, Caller: model.Caller{Cwd: dir}}}
			a, err := NewScheduleAction("schedule.run", testSchedule("sched_a", "alpha", true))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := b.Act(ctx, a)
			req := <-mutation
			if mode == "run-uncertain" {
				if err != nil || !result.Uncertain || result.OperationID != "op_attempt" {
					t.Fatalf("uncertain occurrence hidden: %+v %v", result, err)
				}
			} else {
				var problem *model.Error
				if !errors.As(err, &problem) || !result.Uncertain || result.OperationID == "" || result.OperationID != req.ID {
					t.Fatalf("uncertainty lost: %+v %v", result, err)
				}
			}
			if mutations.Load() != 1 || req.ID == "" || string(req.Args) != `{"id":"sched_a"}` {
				t.Fatalf("resent or changed: count %d %+v %s", mutations.Load(), req, req.Args)
			}
			if req.Scope != (model.Scope{SessionID: "session_a", WorkspaceID: "workspace_a"}) || req.Caller.WorkerID != "" {
				t.Fatalf("frozen scope/actor lost: %+v", req)
			}
		})
	}
}

func TestInvalidScheduleActionsFailBeforeSocketMutation(t *testing.T) {
	good := testSchedule("sched_a", "alpha", true)
	for name, change := range map[string]func(*model.Schedule){
		"no id":        func(s *model.Schedule) { s.ID = "" },
		"bad id":       func(s *model.Schedule) { s.ID = "bad id" },
		"no session":   func(s *model.Schedule) { s.SessionID = "" },
		"no workspace": func(s *model.Schedule) { s.WorkspaceID = "" },
		"removed":      func(s *model.Schedule) { s.State = "removed" },
	} {
		s := good
		change(&s)
		if _, err := NewScheduleAction("schedule.run", s); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if _, err := NewScheduleAction("schedule.remove", good); err == nil {
		t.Fatal("remove is CLI-only")
	}
	b := RPCBackend{Base: &client.Client{Caller: model.Caller{Cwd: "/tmp"}}}
	for _, a := range []Action{
		{Kind: "schedule.run", ID: "sched_a", Scope: model.Scope{Global: true}},
		{Kind: "schedule.enable", ID: "bad id", Scope: model.Scope{SessionID: "s", WorkspaceID: "w"}},
		{Kind: "schedule.disable", ID: "sched_a", Scope: model.Scope{SessionID: "s"}},
		{Kind: "schedule.run", ID: "sched_a", Scope: model.Scope{SessionID: "s", WorkspaceID: "w"}, Body: "payload"},
		{Kind: "schedule.add", ID: "sched_a", Scope: model.Scope{SessionID: "s", WorkspaceID: "w"}},
		{Kind: "schedule.remove", ID: "sched_a", Scope: model.Scope{SessionID: "s", WorkspaceID: "w"}},
	} {
		if result, err := b.Act(context.Background(), a); err == nil || result.Uncertain {
			t.Fatalf("invalid schedule action sent: %+v %+v %v", a, result, err)
		}
	}
}

func TestScheduleOccurrenceBadgeColorsSettledAndUncertain(t *testing.T) {
	m := scheduleModel(t, nil)
	m.colors = true
	lines := m.decorate([]string{"Occurrence srun_s [settled] trigger:scheduled", "Occurrence srun_u [uncertain] trigger:manual", "Occurrence srun_p [persisted] trigger:manual"}, "detail")
	if !strings.Contains(lines[0], m.paint("[settled]", "success")) || !strings.Contains(lines[1], m.paint("[uncertain]", "warning")) {
		t.Fatalf("state badges not colored: %q", lines)
	}
	for i, want := range []string{"Occurrence srun_s [settled] trigger:scheduled", "Occurrence srun_u [uncertain] trigger:manual", "Occurrence srun_p [persisted] trigger:manual"} {
		if ansi.Strip(lines[i]) != want {
			t.Fatalf("decoration changed text: %q", lines[i])
		}
	}
	m.colors = false
	if got := m.decorate([]string{"Occurrence srun_s [settled] x"}, "detail")[0]; got != "Occurrence srun_s [settled] x" {
		t.Fatalf("plain decoration styled: %q", got)
	}
}

func TestScheduleRunEventsMarkDetailStaleGenerically(t *testing.T) {
	for _, typ := range []string{"schedule.run.settled", "schedule.run.skipped", "schedule.run.failed", "schedule.disabled"} {
		m := scheduleModel(t, nil)
		m.scheduleDetailID, m.scheduleDetailState = "sched_a", "done"
		_, cmd := m.Update(streamMsg{generation: m.generation, update: StreamUpdate{Event: &model.Event{Seq: 5, Type: typ}}})
		if m.scheduleDetailState != "stale" || !m.dirty || cmd == nil {
			t.Fatalf("%s did not mark schedules stale and schedule a reload", typ)
		}
	}
}
