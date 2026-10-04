package store

import (
	"github.com/zielus/herdr-woof/internal/model"
	"strings"
)

// Entity selectors use that entity's id; ancestor/descendant selectors traverse
// known relationships rather than guessing a missing column or discarding scope.
var selectors = map[string][5]string{
	"sessions": {
		"t.id=?",
		"EXISTS(SELECT 1 FROM workspaces x WHERE x.session_id=t.id AND x.id=?)",
		"EXISTS(SELECT 1 FROM worktrees x WHERE x.session_id=t.id AND x.id=?)",
		"EXISTS(SELECT 1 FROM runs x WHERE x.session_id=t.id AND x.id=?)",
		"EXISTS(SELECT 1 FROM workers x WHERE x.session_id=t.id AND x.id=?)",
	},
	"workspaces": {
		"t.session_id=?", "t.id=?",
		"EXISTS(SELECT 1 FROM worktrees x WHERE x.workspace_id=t.id AND x.id=?)",
		"EXISTS(SELECT 1 FROM runs x WHERE x.workspace_id=t.id AND x.id=?)",
		"EXISTS(SELECT 1 FROM workers x WHERE x.workspace_id=t.id AND x.id=?)",
	},
	"worktrees": {
		"t.session_id=?", "t.workspace_id=?", "t.id=?",
		"EXISTS(SELECT 1 FROM runs x WHERE (x.worktree_id=t.id OR t.owner_run_id=x.id) AND x.id=?)",
		"EXISTS(SELECT 1 FROM workers x WHERE x.worktree_id=t.id AND x.id=?)",
	},
	"runs": {
		"t.session_id=?", "t.workspace_id=?", "t.worktree_id=?", "t.id=?",
		"EXISTS(SELECT 1 FROM workers x WHERE x.id=? AND (x.run_id=t.id OR t.invoker_worker_id=x.id OR EXISTS(SELECT 1 FROM dispatches d WHERE d.run_id=t.id AND d.worker_id=x.id)))",
	},
	"workers": {"t.session_id=?", "t.workspace_id=?", "t.worktree_id=?", "EXISTS(SELECT 1 FROM runs x WHERE x.id=? AND (t.run_id=x.id OR EXISTS(SELECT 1 FROM dispatches d WHERE d.run_id=x.id AND d.worker_id=t.id)))", "t.id=?"},
	"messages": {
		"t.session_id=?", "t.workspace_id=?", "t.worktree_id=?", "t.run_id=?",
		"EXISTS(SELECT 1 FROM workers x WHERE x.id=? AND (t.from_worker_id=x.id OR (t.to_kind='worker' AND t.to_id=x.id) OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=t.id AND d.worker_id=x.id)))",
	},
	"deliveries": {
		"t.session_id=?", "t.workspace_id=?",
		"CASE WHEN t.human=1 THEN (SELECT x.worktree_id FROM messages x WHERE x.id=t.message_id) ELSE (SELECT x.worktree_id FROM workers x WHERE x.id=t.worker_id) END=?",
		"t.run_id=?", "t.worker_id=?",
	},
	"dispatches": {"t.session_id=?", "t.workspace_id=?", "t.worktree_id=?", "t.run_id=?", "t.worker_id=?"},
	"gates": {
		"t.session_id=?", "t.workspace_id=?",
		"EXISTS(SELECT 1 FROM runs x WHERE x.id=t.run_id AND x.worktree_id=?)",
		"t.run_id=?",
		"EXISTS(SELECT 1 FROM workers x WHERE x.id=? AND (x.run_id=t.run_id OR EXISTS(SELECT 1 FROM runs r WHERE r.id=t.run_id AND r.invoker_worker_id=x.id) OR EXISTS(SELECT 1 FROM dispatches d WHERE d.run_id=t.run_id AND d.worker_id=x.id)))",
	},
	"schedules": {
		"t.session_id=?", "t.workspace_id=?",
		"EXISTS(SELECT 1 FROM workers x WHERE x.id=t.worker_id AND x.worktree_id=?)",
		"EXISTS(SELECT 1 FROM schedule_runs x WHERE x.schedule_id=t.id AND x.run_id=?)",
		"t.worker_id=?",
	},
	"schedule_runs": {
		"t.session_id=?", "t.workspace_id=?",
		"EXISTS(SELECT 1 FROM workers x WHERE x.id=t.worker_id AND x.worktree_id=?)",
		"t.run_id=?", "t.worker_id=?",
	},
	"events": {"t.session_id=?", "t.workspace_id=?", "t.worktree_id=?", "t.run_id=?", "t.worker_id=?"},
}

func scopeWhere(kind string, s model.Scope) (string, []any, error) {
	if s.Global {
		return "1=1", nil, nil
	}
	values := [5]string{s.SessionID, s.WorkspaceID, s.WorktreeID, s.RunID, s.WorkerID}
	expressions := selectors[kind]
	clauses := []string{"1=1"}
	var args []any
	for i, v := range values {
		if v == "" {
			continue
		}
		if expressions[i] == "" {
			return "", nil, refusal("invalid_scope", "%s records do not support scoped selectors; use global scope", kind)
		}
		clauses = append(clauses, "("+expressions[i]+")")
		args = append(args, v)
	}
	return strings.Join(clauses, " AND "), args, nil
}
