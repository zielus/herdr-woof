// Package model defines durable Woof identities and RPC-visible records.
package model

import "encoding/json"

const Protocol = 1

// ExtraArgsProtocol gates per-launch argv so older daemons reject before spawn.
const ExtraArgsProtocol = 2

type Scope struct {
	SessionID   string `json:"session_id,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	WorktreeID  string `json:"worktree_id,omitempty"`
	RunID       string `json:"run_id,omitempty"`
	WorkerID    string `json:"worker_id,omitempty"`
	Global      bool   `json:"global,omitempty"`
}

type Caller struct {
	WorkerID     string `json:"worker_id,omitempty"`
	AttachmentID string `json:"attachment_id,omitempty"`
	HerdrSocket  string `json:"herdr_socket,omitempty"`
	PaneID       string `json:"pane_id,omitempty"`
	ProcessID    int    `json:"process_id,omitempty"`
	Cwd          string `json:"cwd,omitempty"`
}

type Session struct {
	ID         string `json:"id"`
	HerdrName  string `json:"herdr_name"`
	SocketPath string `json:"socket_path"`
	Status     string `json:"status"`
	Protocol   int    `json:"protocol"`
	Generation int64  `json:"generation"`
	CreatedAt  int64  `json:"created_at"`
	LastSeenAt int64  `json:"last_seen_at"`
	Error      string `json:"error,omitempty"`
}

type Workspace struct {
	ID               string `json:"id"`
	SessionID        string `json:"session_id"`
	HerdrWorkspaceID string `json:"herdr_workspace_id"`
	Cwd              string `json:"cwd"`
	Name             string `json:"name"`
	CreatedAt        int64  `json:"created_at"`
	UpdatedAt        int64  `json:"updated_at"`
}

type Worktree struct {
	ID            string `json:"id"`
	WorkspaceID   string `json:"workspace_id"`
	SessionID     string `json:"session_id"`
	Path          string `json:"path"`
	RepoPath      string `json:"repo_path,omitempty"`
	Branch        string `json:"branch,omitempty"`
	OwnershipKind string `json:"ownership_kind"`
	OwnerRunID    string `json:"owner_run_id,omitempty"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

type Run struct {
	ID              string `json:"id"`
	SessionID       string `json:"session_id"`
	WorkspaceID     string `json:"workspace_id,omitempty"`
	WorktreeID      string `json:"worktree_id,omitempty"`
	InvokerWorkerID string `json:"invoker_worker_id,omitempty"`
	InvokerPaneRef  string `json:"invoker_pane_ref,omitempty"`
	Kind            string `json:"kind"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	Implicit        bool   `json:"implicit"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
	CompletedAt     int64  `json:"completed_at,omitempty"`
}

type NativeSession struct {
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

type ProcessIdentity struct {
	PID   int    `json:"pid"`
	Birth string `json:"birth"`
	TTY   string `json:"tty,omitempty"`
}

type Worker struct {
	ID             string           `json:"id"`
	OperationID    string           `json:"operation_id,omitempty"`
	SessionID      string           `json:"session_id"`
	WorkspaceID    string           `json:"workspace_id"`
	WorktreeID     string           `json:"worktree_id,omitempty"`
	RunID          string           `json:"run_id,omitempty"`
	Name           string           `json:"name"`
	ProfileName    string           `json:"profile_name,omitempty"`
	AgentKind      string           `json:"agent_kind"`
	Args           []string         `json:"args,omitempty"`
	Cwd            string           `json:"cwd"`
	PaneID         string           `json:"pane_id,omitempty"`
	PaneAliases    []string         `json:"pane_aliases,omitempty"`
	AgentName      string           `json:"agent_name,omitempty"`
	TerminalID     string           `json:"terminal_id,omitempty"`
	NativeSession  *NativeSession   `json:"native_session,omitempty"`
	AgentProcess   *ProcessIdentity `json:"agent_process,omitempty"`
	AttachmentID   string           `json:"attachment_id"`
	Generation     int64            `json:"generation"`
	State          string           `json:"state"`
	RawStatus      string           `json:"raw_status"`
	Revision       uint64           `json:"revision"`
	StateSeq       uint64           `json:"state_seq"`
	CompletionSeq  *uint64          `json:"completion_seq,omitempty"`
	Ready          bool             `json:"ready"`
	RecoveryHeld   bool             `json:"recovery_held,omitempty"`
	RecoveryPaneID string           `json:"recovery_pane_id,omitempty"`
	RecoveryReadAt int64            `json:"recovery_read_at,omitempty"`
	Retained       bool             `json:"retained"`
	CreatedAt      int64            `json:"created_at"`
	UpdatedAt      int64            `json:"updated_at"`
	LastSeenAt     int64            `json:"last_seen_at"`
	BlockedAt      int64            `json:"blocked_at,omitempty"`
	Alerts         map[string]bool  `json:"alerts,omitempty"`
	Error          string           `json:"error,omitempty"`
}

type Artifact struct {
	Path  string `json:"path"`
	Label string `json:"label,omitempty"`
}

type Message struct {
	ID               string     `json:"id"`
	SessionID        string     `json:"session_id,omitempty"`
	WorkspaceID      string     `json:"workspace_id,omitempty"`
	WorktreeID       string     `json:"worktree_id,omitempty"`
	RunID            string     `json:"run_id,omitempty"`
	FromKind         string     `json:"from_kind"`
	FromWorkerID     string     `json:"from_worker_id,omitempty"`
	ToKind           string     `json:"to_kind"`
	ToID             string     `json:"to_id,omitempty"`
	Subject          string     `json:"subject,omitempty"`
	Body             string     `json:"body"`
	Kind             string     `json:"kind"`
	Status           string     `json:"status"`
	ReplyToMessageID string     `json:"reply_to_message_id,omitempty"`
	DispatchID       string     `json:"dispatch_id,omitempty"`
	Artifacts        []Artifact `json:"artifacts,omitempty"`
	CreatedAt        int64      `json:"created_at"`
	DeliveredAt      int64      `json:"delivered_at,omitempty"`
	AcknowledgedAt   int64      `json:"acknowledged_at,omitempty"`
	ConsumedAt       int64      `json:"consumed_at,omitempty"`
}

type Delivery struct {
	ID                    string  `json:"id"`
	MessageID             string  `json:"message_id"`
	WorkerID              string  `json:"worker_id,omitempty"`
	SessionID             string  `json:"session_id,omitempty"`
	WorkspaceID           string  `json:"workspace_id,omitempty"`
	RunID                 string  `json:"run_id,omitempty"`
	Human                 bool    `json:"human"`
	Status                string  `json:"status"`
	WakeStatus            string  `json:"wake_status"`
	AttemptID             string  `json:"attempt_id,omitempty"`
	AttachmentID          string  `json:"attachment_id,omitempty"`
	BaselineSeq           uint64  `json:"baseline_seq"`
	WorkingSeq            uint64  `json:"working_seq"`
	BaselineCompletionSeq *uint64 `json:"baseline_completion_seq,omitempty"`
	CreatedAt             int64   `json:"created_at"`
	UpdatedAt             int64   `json:"updated_at"`
	AttemptedAt           int64   `json:"attempted_at,omitempty"`
	DeliveredAt           int64   `json:"delivered_at,omitempty"`
	AcknowledgedAt        int64   `json:"acknowledged_at,omitempty"`
	ConsumedAt            int64   `json:"consumed_at,omitempty"`
	Escalated             bool    `json:"escalated"`
	Error                 string  `json:"error,omitempty"`
}

type Dispatch struct {
	ID                    string          `json:"id"`
	SessionID             string          `json:"session_id"`
	WorkspaceID           string          `json:"workspace_id"`
	WorktreeID            string          `json:"worktree_id,omitempty"`
	RunID                 string          `json:"run_id"`
	WorkerID              string          `json:"worker_id"`
	AttachmentID          string          `json:"attachment_id"`
	Spec                  string          `json:"spec"`
	Handoff               string          `json:"handoff,omitempty"`
	Status                string          `json:"status"`
	Attempt               int             `json:"attempt"`
	BaselineSeq           uint64          `json:"baseline_seq"`
	BaselineCompletionSeq *uint64         `json:"baseline_completion_seq,omitempty"`
	ObservedWorkingAt     int64           `json:"observed_working_at,omitempty"`
	LastActivityAt        int64           `json:"last_activity_at,omitempty"`
	WorkingSeq            uint64          `json:"working_seq"`
	TurnEnded             bool            `json:"turn_ended"`
	EndSeq                uint64          `json:"end_seq"`
	DoneMessageID         string          `json:"done_message_id,omitempty"`
	ReportOutcome         string          `json:"report_outcome,omitempty"`
	DoneAt                int64           `json:"done_at,omitempty"`
	CreatedAt             int64           `json:"created_at"`
	SentAt                int64           `json:"sent_at,omitempty"`
	IdleAt                int64           `json:"idle_at,omitempty"`
	SettledAt             int64           `json:"settled_at,omitempty"`
	Outcome               string          `json:"outcome,omitempty"`
	Alerts                map[string]bool `json:"alerts,omitempty"`
	Nudges                int             `json:"nudges"`
	OperationID           string          `json:"operation_id,omitempty"`
}

type Gate struct {
	ID          string   `json:"id"`
	SessionID   string   `json:"session_id,omitempty"`
	WorkspaceID string   `json:"workspace_id,omitempty"`
	RunID       string   `json:"run_id,omitempty"`
	Question    string   `json:"question"`
	Options     []string `json:"options"`
	Status      string   `json:"status"`
	Decision    string   `json:"decision,omitempty"`
	CreatedAt   int64    `json:"created_at"`
	ResolvedAt  int64    `json:"resolved_at,omitempty"`
}

type Operation struct {
	ID           string          `json:"id"`
	Op           string          `json:"op"`
	Fingerprint  string          `json:"fingerprint"`
	State        string          `json:"state"`
	ResourceKind string          `json:"resource_kind,omitempty"`
	ResourceID   string          `json:"resource_id,omitempty"`
	Result       json.RawMessage `json:"result,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	Error        string          `json:"error,omitempty"`
	CreatedAt    int64           `json:"created_at"`
	UpdatedAt    int64           `json:"updated_at"`
}

type Event struct {
	Seq  int64  `json:"seq"`
	ID   string `json:"event_id"`
	Type string `json:"type"`
	Scope
	ActorKind string          `json:"actor_kind"`
	ActorID   string          `json:"actor_id,omitempty"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt int64           `json:"created_at"`
}

type Request struct {
	Version       int             `json:"version"`
	ID            string          `json:"id,omitempty"`
	Op            string          `json:"op"`
	Caller        Caller          `json:"caller"`
	Scope         Scope           `json:"scope"`
	ScopeExplicit bool            `json:"scope_explicit,omitempty"`
	Args          json.RawMessage `json:"args,omitempty"`
}

type Error struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	OperationID string `json:"operation_id,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type Response struct {
	Version int             `json:"version"`
	OK      bool            `json:"ok"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// EventTail captures the global replay boundary before selecting the latest
// scoped events. EventCursor can exceed the last matching event sequence.
type EventTail struct {
	Events      []Event `json:"events"`
	EventCursor int64   `json:"event_cursor"`
}
