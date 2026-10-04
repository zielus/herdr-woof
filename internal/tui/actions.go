package tui

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/zielus/herdr-woof/internal/model"
)

// NewWorkerAction freezes routing to the durable worker, independent of the
// browse scope and of later pane changes.
func NewWorkerAction(kind string, w model.Worker, browse model.Scope) (Action, error) {
	if kind != "send" && kind != "ask" {
		return Action{}, fmt.Errorf("unsupported worker action %q", kind)
	}
	if !actionID(w.ID) || !actionID(w.SessionID) || !actionID(w.WorkspaceID) {
		return Action{}, fmt.Errorf("worker identity and scope are required")
	}
	scope := model.Scope{SessionID: w.SessionID, WorkspaceID: w.WorkspaceID, WorktreeID: w.WorktreeID}
	compatible := (browse.SessionID == "" || browse.SessionID == w.SessionID) && (browse.WorkspaceID == "" || browse.WorkspaceID == w.WorkspaceID) && (browse.WorktreeID == "" || browse.WorktreeID == w.WorktreeID)
	resolved := browse.SessionID == w.SessionID
	if browse.RunID != "" && compatible && (browse.RunID == w.RunID || resolved) {
		scope.RunID = browse.RunID
	}
	return Action{Kind: kind, Scope: scope, To: "worker:" + w.ID, Label: w.Name}, nil
}

func messageScope(m model.Message) model.Scope {
	return model.Scope{SessionID: m.SessionID, WorkspaceID: m.WorkspaceID, WorktreeID: m.WorktreeID, RunID: m.RunID}
}
func humanReceipt(entry InboxEntry) bool {
	d := entry.Delivery
	return actionID(d.ID) && d.MessageID == entry.Message.ID && d.Human && d.WorkerID == ""
}
func humanQuestion(m model.Message) bool {
	return m.Kind == "question" && m.Status != "replied" && m.ToKind == "human" && (m.ToID == "human" || m.ToID == "")
}

// NewMessageAction never grants control over a worker's mailbox.
func NewMessageAction(kind string, entry InboxEntry) (Action, error) {
	if kind != "reply" && kind != "ack" && kind != "consume" {
		return Action{}, fmt.Errorf("unsupported message action %q", kind)
	}
	if !actionID(entry.Message.ID) || !humanReceipt(entry) {
		return Action{}, fmt.Errorf("action requires a human-owned receipt")
	}
	if kind == "reply" && !humanQuestion(entry.Message) {
		return Action{}, fmt.Errorf("reply requires an unreplied question addressed to human")
	}
	to := "human"
	if kind == "reply" {
		if entry.Message.FromWorkerID != "" && !actionID(entry.Message.FromWorkerID) {
			return Action{}, fmt.Errorf("invalid original question sender")
		}
		to = replyRecipient(entry.Message)
	}
	return Action{Kind: kind, Scope: messageScope(entry.Message), ID: entry.Message.ID, To: to, Label: entry.Message.Subject}, nil
}

func replyRecipient(m model.Message) string {
	if m.FromWorkerID != "" {
		return "worker:" + m.FromWorkerID
	}
	return "human"
}

func NewGateAction(gate model.Gate) (Action, error) {
	if !actionID(gate.ID) || gate.Status != "open" {
		return Action{}, fmt.Errorf("resolve requires an open gate")
	}
	return Action{Kind: "gate.resolve", Scope: model.Scope{SessionID: gate.SessionID, WorkspaceID: gate.WorkspaceID, RunID: gate.RunID}, ID: gate.ID, Options: append([]string(nil), gate.Options...), Label: gate.Question}, nil
}

// Schedule actions are the only scheduler mutations in the TUI. Add and remove
// stay CLI-only; the reviewed identity and scope are frozen here.
var scheduleKinds = map[string]string{"schedule.enable": "Enable", "schedule.disable": "Disable", "schedule.run": "Run now"}

func isScheduleKind(kind string) bool { _, ok := scheduleKinds[kind]; return ok }

// NewScheduleAction freezes the schedule's durable ID, session and workspace.
// The target worker ID is fixed at creation and never retargeted.
func NewScheduleAction(kind string, sc model.Schedule) (Action, error) {
	if !isScheduleKind(kind) {
		return Action{}, fmt.Errorf("unsupported schedule action %q", kind)
	}
	if !actionID(sc.ID) || !actionID(sc.SessionID) || !actionID(sc.WorkspaceID) {
		return Action{}, fmt.Errorf("schedule identity and scope are required")
	}
	if sc.State == "removed" {
		return Action{}, fmt.Errorf("schedule %s was removed", sc.ID)
	}
	frozen := sc
	return Action{Kind: kind, Scope: model.Scope{SessionID: sc.SessionID, WorkspaceID: sc.WorkspaceID}, ID: sc.ID, To: "worker:" + sc.WorkerID, Label: sc.Name, Schedule: &frozen}, nil
}

func actionID(id string) bool {
	return id != "" && !strings.ContainsFunc(id, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == ':' })
}
func cloneAction(a Action) Action {
	a.Artifacts = append([]string(nil), a.Artifacts...)
	a.Options = append([]string(nil), a.Options...)
	if a.Schedule != nil {
		sc := *a.Schedule
		a.Schedule = &sc
	}
	return a
}
func validateAction(a Action) error {
	if a.Scope.WorkerID != "" {
		return fmt.Errorf("human actions cannot select a worker mailbox")
	}
	for _, id := range []string{a.Scope.SessionID, a.Scope.WorkspaceID, a.Scope.WorktreeID, a.Scope.RunID} {
		if id != "" && !actionID(id) {
			return fmt.Errorf("invalid scope ID")
		}
	}
	if a.Scope.Global && (a.Scope.SessionID != "" || a.Scope.WorkspaceID != "" || a.Scope.WorktreeID != "" || a.Scope.RunID != "") {
		return fmt.Errorf("global scope cannot include scope IDs")
	}
	switch a.Kind {
	case "send", "ask":
		if a.To != "human" && (!strings.HasPrefix(a.To, "worker:") || !actionID(strings.TrimPrefix(a.To, "worker:"))) {
			return fmt.Errorf("recipient must be human or a durable worker ID")
		}
		if strings.TrimSpace(a.Body) == "" {
			return fmt.Errorf("message body is required")
		}
	case "reply":
		if a.To != "human" && (!strings.HasPrefix(a.To, "worker:") || !actionID(strings.TrimPrefix(a.To, "worker:"))) {
			return fmt.Errorf("reply recipient must be human or a durable worker ID")
		}
		if !actionID(a.ID) {
			return fmt.Errorf("question ID is required")
		}
		if strings.TrimSpace(a.Body) == "" {
			return fmt.Errorf("reply body is required")
		}
	case "ack", "consume":
		if !actionID(a.ID) {
			return fmt.Errorf("message ID is required")
		}
	case "gate.resolve":
		if !actionID(a.ID) {
			return fmt.Errorf("gate ID is required")
		}
		if strings.TrimSpace(a.Decision) == "" {
			return fmt.Errorf("decision is required")
		}
		if len(a.Options) > 0 {
			valid := false
			for _, o := range a.Options {
				valid = valid || o == a.Decision
			}
			if !valid {
				return fmt.Errorf("decision must be one of the gate options")
			}
		}
	case "schedule.enable", "schedule.disable", "schedule.run":
		if !actionID(a.ID) {
			return fmt.Errorf("schedule ID is required")
		}
		if a.Scope.Global || !actionID(a.Scope.SessionID) || !actionID(a.Scope.WorkspaceID) {
			return fmt.Errorf("schedule actions require the schedule's session and workspace")
		}
		if len(a.Artifacts) > 0 || a.Body != "" || a.Decision != "" {
			return fmt.Errorf("schedule actions carry only the schedule ID")
		}
	default:
		return fmt.Errorf("unsupported action %q", a.Kind)
	}
	for _, p := range a.Artifacts {
		if p == "" || strings.ContainsRune(p, 0) {
			return fmt.Errorf("artifact path must be nonempty and contain no NUL")
		}
	}
	return nil
}
