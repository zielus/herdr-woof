// Package tui is the human operator interface to the global Woof daemon.
package tui

import (
	"context"
	"encoding/json"
	"github.com/zielus/herdr-woof-v2/internal/artifacts"
	"github.com/zielus/herdr-woof-v2/internal/client"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/profiles"
)

type InboxEntry struct {
	Message   model.Message          `json:"message"`
	Delivery  model.Delivery         `json:"delivery"`
	Artifacts []artifacts.FileStatus `json:"artifacts"`
}
type MessageDetail struct {
	Message    model.Message          `json:"message"`
	Deliveries []model.Delivery       `json:"deliveries"`
	Artifacts  []artifacts.FileStatus `json:"artifacts"`
}
type Snapshot struct {
	Errors map[string]string

	Scope          model.Scope
	Cursor         int64
	Sessions       []model.Session
	Workspaces     []model.Workspace
	Worktrees      []model.Worktree
	Runs           []model.Run
	Workers        []model.Worker
	Dispatches     []model.Dispatch
	Inbox          []InboxEntry
	Gates          []model.Gate
	Events         []model.Event
	Profiles       []profiles.Summary
	ProfileDetails map[string]profiles.Profile
	Reports        map[string]MessageDetail
	WorkerInboxes  map[string][]InboxEntry
	// Schedules are non-removed native schedules in the browse scope; the
	// daemon joins each schedule's latest occurrence as LastRun.
	Schedules []model.Schedule
}

// ScheduleRunView mirrors the daemon's schedule.show/schedule.history run view:
// linked delivery, dispatch and attempt receipt stay canonical in their rows.
type ScheduleRunView struct {
	Run        model.ScheduleRun `json:"run"`
	Message    *model.Message    `json:"message,omitempty"`
	Deliveries []model.Delivery  `json:"deliveries,omitempty"`
	Dispatch   *model.Dispatch   `json:"dispatch,omitempty"`
	Operation  *model.Operation  `json:"operation,omitempty"`
}
type ScheduleOccurrence struct {
	At    int64  `json:"at"`
	Local string `json:"local"`
}

// ScheduleDetail is the schedule.show read: identity, the next five
// occurrences and recent runs, newest first.
type ScheduleDetail struct {
	Schedule model.Schedule       `json:"schedule"`
	Upcoming []ScheduleOccurrence `json:"upcoming"`
	Runs     []ScheduleRunView    `json:"runs"`
}
type Action struct {
	Kind      string
	Scope     model.Scope
	ID        string
	To        string
	Subject   string
	Body      string
	Artifacts []string
	Decision  string
	Options   []string
	Label     string
	// Schedule freezes the reviewed schedule for enable/disable/run-now.
	Schedule *model.Schedule
}
type ActionResult struct {
	Value       json.RawMessage
	OperationID string
	Uncertain   bool
}
type StreamUpdate struct {
	Event *model.Event
	Err   error
}
type Backend interface {
	Load(context.Context, model.Scope) (Snapshot, error)
	Follow(context.Context, model.Scope, int64, func(StreamUpdate) error) error
	Act(context.Context, Action) (ActionResult, error)
	Operation(context.Context, string) (model.Operation, error)
	ScheduleDetail(context.Context, model.Scope, string) (ScheduleDetail, error)
	ScheduleRun(context.Context, string, string) (ScheduleRunView, error)
}
type RPCBackend struct{ Base *client.Client }
type ConnectionError struct{ Err error }

func (e *ConnectionError) Error() string { return e.Err.Error() }
func (e *ConnectionError) Unwrap() error { return e.Err }
