package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/zielus/herdr-woof/internal/artifacts"
	"github.com/zielus/herdr-woof/internal/client"
	"github.com/zielus/herdr-woof/internal/model"
)

// Act delegates each mutation once through the existing uncertainty-aware
// client. It never waits for a question answer or retries a submitted action.
func (b *RPCBackend) Act(ctx context.Context, action Action) (ActionResult, error) {
	a := cloneAction(action)
	if err := validateAction(a); err != nil {
		return ActionResult{}, err
	}
	if b == nil || b.Base == nil {
		return ActionResult{}, fmt.Errorf("woof client is unavailable")
	}
	c := *b.Base
	c.Caller = model.Caller{ProcessID: c.Caller.ProcessID, Cwd: c.Caller.Cwd}
	c.Scope = a.Scope
	c.ScopeExplicit = true
	refs, err := artifacts.Resolve(a.Artifacts, c.Caller.Cwd)
	if err != nil {
		return ActionResult{}, err
	}
	if err = b.validateActionTarget(ctx, a); err != nil {
		return ActionResult{}, err
	}
	if isScheduleKind(a.Kind) {
		return actSchedule(ctx, &c, a)
	}
	payload := struct {
		ID        string   `json:"id,omitempty"`
		To        string   `json:"to,omitempty"`
		Subject   string   `json:"subject,omitempty"`
		Body      string   `json:"body,omitempty"`
		Decision  string   `json:"decision,omitempty"`
		Artifacts []string `json:"artifacts,omitempty"`
	}{ID: a.ID, To: a.To, Subject: a.Subject, Body: a.Body, Decision: a.Decision}
	for _, ref := range refs {
		payload.Artifacts = append(payload.Artifacts, ref.Path)
	}
	var result ActionResult
	err = c.Call(ctx, a.Kind, payload, &result.Value)
	var problem *model.Error
	if errors.As(err, &problem) {
		result.OperationID = problem.OperationID
		result.Uncertain = problem.Code == "outcome_unknown" || problem.Code == "uncertain"
	}
	return result, err
}

// actSchedule sends exactly one schedule mutation carrying only the reviewed ID.
// A run-now whose dispatch prompt outcome is unknown is surfaced through its
// attempt receipt and, like a lost response, is never resent.
func actSchedule(ctx context.Context, c *client.Client, a Action) (ActionResult, error) {
	var result ActionResult
	err := c.Call(ctx, a.Kind, map[string]string{"id": a.ID}, &result.Value)
	var problem *model.Error
	if errors.As(err, &problem) {
		result.OperationID = problem.OperationID
		result.Uncertain = problem.Code == "outcome_unknown" || problem.Code == "uncertain"
		return result, err
	}
	if err == nil && a.Kind == "schedule.run" {
		var run model.ScheduleRun
		if json.Unmarshal(result.Value, &run) == nil && run.State == "uncertain" && run.AttemptID != "" {
			result.OperationID = run.AttemptID
			result.Uncertain = true
		}
	}
	return result, err
}

// Resolve the frozen target with a clean human read. The daemon remains the
// final authority and checks ownership again within its mutation transaction.
func (b *RPCBackend) validateActionTarget(ctx context.Context, a Action) error {
	c := *b.Base
	c.Caller = model.Caller{ProcessID: c.Caller.ProcessID, Cwd: c.Caller.Cwd}
	c.Scope = model.Scope{Global: true}
	c.ScopeExplicit = true
	switch a.Kind {
	case "send", "ask":
		if a.To == "human" {
			return nil
		}
		var w model.Worker
		if err := c.Call(ctx, "worker.show", map[string]string{"id": strings.TrimPrefix(a.To, "worker:")}, &w); err != nil {
			return err
		}
		if w.ID != strings.TrimPrefix(a.To, "worker:") || a.Scope.SessionID != w.SessionID || a.Scope.WorkspaceID != w.WorkspaceID || a.Scope.WorktreeID != w.WorktreeID || a.Scope.Global {
			return fmt.Errorf("worker scope changed; reload and start a new action")
		}
		if a.Scope.RunID != "" {
			var run model.Run
			if err := c.Call(ctx, "run.show", map[string]string{"id": a.Scope.RunID}, &run); err != nil {
				return err
			}
			if run.ID != a.Scope.RunID || run.SessionID != w.SessionID || (run.WorkspaceID != "" && run.WorkspaceID != w.WorkspaceID) || (run.WorktreeID != "" && run.WorktreeID != w.WorktreeID) {
				return fmt.Errorf("selected run does not match worker scope")
			}
		}
	case "reply", "ack", "consume":
		var detail MessageDetail
		if err := c.Call(ctx, "message.show", map[string]string{"id": a.ID}, &detail); err != nil {
			return err
		}
		if detail.Message.ID != a.ID || !sameActionScope(a.Scope, messageScope(detail.Message)) {
			return fmt.Errorf("message scope changed; reload and start a new action")
		}
		owned := false
		for _, d := range detail.Deliveries {
			owned = owned || humanReceipt(InboxEntry{Message: detail.Message, Delivery: d})
		}
		if !owned {
			return fmt.Errorf("action requires a human-owned receipt")
		}
		if a.Kind == "reply" {
			if !humanQuestion(detail.Message) {
				return fmt.Errorf("reply requires an unreplied question addressed to human")
			}
			if a.To != replyRecipient(detail.Message) {
				return fmt.Errorf("question sender changed; reload and review the reply recipient again")
			}
		}
	case "schedule.enable", "schedule.disable", "schedule.run":
		var detail ScheduleDetail
		if err := c.Call(ctx, "schedule.show", map[string]string{"id": a.ID}, &detail); err != nil {
			return err
		}
		sc := detail.Schedule
		if sc.ID != a.ID || sc.SessionID != a.Scope.SessionID || sc.WorkspaceID != a.Scope.WorkspaceID {
			return fmt.Errorf("schedule scope changed; reload and start a new action")
		}
		if sc.State == "removed" {
			return fmt.Errorf("schedule %s was removed", sc.ID)
		}
		if a.Schedule != nil && a.Schedule.WorkerID != sc.WorkerID {
			return fmt.Errorf("schedule target changed; reload and review again")
		}
	case "gate.resolve":
		var gate model.Gate
		if err := c.Call(ctx, "gate.show", map[string]string{"id": a.ID}, &gate); err != nil {
			return err
		}
		frozen, err := NewGateAction(gate)
		if err != nil {
			return err
		}
		if gate.ID != a.ID || !sameActionScope(a.Scope, frozen.Scope) {
			return fmt.Errorf("gate scope changed; reload and start a new action")
		}
		frozen.Decision = a.Decision
		if err = validateAction(frozen); err != nil {
			return err
		}
	}
	return nil
}

func sameActionScope(a, b model.Scope) bool {
	// An empty global selection and an unscoped record denote the same human
	// scope; never carry a worker selector into a receipt mutation.
	a.Global = false
	b.Global = false
	return a == b
}
