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
}
type RPCBackend struct{ Base *client.Client }
type ConnectionError struct{ Err error }

func (e *ConnectionError) Error() string { return e.Err.Error() }
func (e *ConnectionError) Unwrap() error { return e.Err }
