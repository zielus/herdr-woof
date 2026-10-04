package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/rpc"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

func isUncertain(err error) bool {
	var me *model.Error
	return errors.Is(err, rpc.ErrLost) || (errors.As(err, &me) && me.Code == "uncertain")
}
func (e *Engine) mutate(ctx context.Context, r model.Request, a Args) (any, error) {
	switch r.Op {
	case "session.attach":
		return e.attachSession(ctx, r, a)
	case "worker.spawn", "worker.adopt", "worker.retain", "worker.release", "worker.stop":
		return e.workerMutation(ctx, r, a)
	case "send", "ask", "reply":
		return e.send(ctx, r, a)
	case "ack", "consume":
		return e.ack(ctx, r, a)
	case "dispatch":
		return e.dispatch(ctx, r, a)
	case "done":
		return e.done(ctx, r, a)
	case "nudge", "fail":
		return e.dispatchControl(ctx, r, a)
	case "schedule.add", "schedule.enable", "schedule.disable", "schedule.remove", "schedule.run":
		return e.scheduleMutate(ctx, r, a)
	case "run.create":
		if r.Scope.SessionID == "" {
			return nil, problem("scope_required", "select a session for the run")
		}
		v := model.Run{ID: newID("run"), SessionID: r.Scope.SessionID, WorkspaceID: r.Scope.WorkspaceID, WorktreeID: r.Scope.WorktreeID, Title: a.Title, Kind: a.Kind, Status: "active", InvokerWorkerID: r.Caller.WorkerID, InvokerPaneRef: r.Caller.PaneID, CreatedAt: e.now(), UpdatedAt: e.now()}
		if v.Kind == "" {
			v.Kind = "manual"
		}
		err := e.write(ctx, func(tx *store.Tx) error {
			if err := tx.Put("runs", v.ID, v); err != nil {
				return err
			}
			if err := tx.Event("run.created", model.Scope{SessionID: v.SessionID, WorkspaceID: v.WorkspaceID, RunID: v.ID}, "worker", r.Caller.WorkerID, v); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, v, nil, "completed")
		})
		return v, err
	case "gate.create":
		if strings.TrimSpace(a.Question) == "" {
			return nil, problem("invalid_args", "gate question required")
		}
		v := model.Gate{ID: newID("gate"), SessionID: r.Scope.SessionID, WorkspaceID: r.Scope.WorkspaceID, RunID: r.Scope.RunID, Question: a.Question, Options: a.Options, Status: "open", CreatedAt: e.now()}
		err := e.write(ctx, func(tx *store.Tx) error {
			if err := tx.Put("gates", v.ID, v); err != nil {
				return err
			}
			if err := tx.Event("gate.created", r.Scope, "worker", r.Caller.WorkerID, v); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, v, nil, "completed")
		})
		return v, err
	case "gate.resolve":
		var v model.Gate
		err := e.write(ctx, func(tx *store.Tx) error {
			var err error
			v, err = txGet[model.Gate](tx, "gates", a.ID)
			if err != nil {
				return err
			}
			if v.Status != "open" {
				return problem("gate_resolved", "gate already resolved")
			}
			if a.Decision == "" {
				return problem("invalid_args", "decision required")
			}
			if len(v.Options) > 0 {
				valid := false
				for _, o := range v.Options {
					valid = valid || a.Decision == o
				}
				if !valid {
					return problem("invalid_args", "decision is not a gate option")
				}
			}
			v.Status = "resolved"
			v.Decision = a.Decision
			v.ResolvedAt = e.now()
			if err = tx.Put("gates", v.ID, v); err != nil {
				return err
			}
			if err = tx.Event("gate.resolved", model.Scope{SessionID: v.SessionID, WorkspaceID: v.WorkspaceID, RunID: v.RunID}, "worker", r.Caller.WorkerID, v); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, v, nil, "completed")
		})
		return v, err
	case "operation.resolve":
		if a.Resolution != "completed" && a.Resolution != "failed" {
			return nil, problem("invalid_args", "resolution must be completed or failed after investigation")
		}
		if a.Reason == "" {
			return nil, problem("invalid_args", "resolution reason required")
		}
		if _, busy := e.inFlight.Load(a.ID); busy {
			return nil, problem("operation_in_flight", "operation is still executing; wait and inspect before resolution")
		}
		var v model.Operation
		err := e.write(ctx, func(tx *store.Tx) error {
			var err error
			v, err = txGet[model.Operation](tx, "operations", a.ID)
			if err != nil {
				return err
			}
			if v.ID == r.ID {
				return problem("invalid_args", "cannot resolve this resolution request")
			}
			finalReceipt := v.State == "completed" && v.ResourceKind == "deliveries"
			if v.State != "uncertain" && v.State != "accepted" && !finalReceipt {
				return problem("invalid_state", "operation has a final receipt")
			}
			// Domain state must be explicitly cleared alongside the receipt. No
			// resolution automatically resubmits a prompt.
			if v.ResourceKind == "workers" && v.Op == "worker.spawn" && a.Resolution == "failed" {
				worker, x := txGet[model.Worker](tx, "workers", v.ResourceID)
				if x != nil {
					return x
				}
				if worker.OperationID != "" && worker.OperationID != v.ID {
					return problem("stale_operation", "worker has a newer lifecycle operation")
				}
				if worker.NativeSession != nil || worker.AgentProcess != nil || (worker.State != "starting" && worker.State != "lost" && worker.State != "offline") {
					return problem("worker_bound", "launch has live identity evidence; inspect and stop or re-adopt the worker instead")
				}
				worker.State = "failed"
				worker.Ready = false
				worker.Error = a.Reason
				worker.OperationID = v.ID
				worker.UpdatedAt = e.now()
				if x = tx.Put("workers", worker.ID, worker); x != nil {
					return x
				}
				if x = tx.Event("worker.launch_resolved", workerScope(worker), "human", r.Caller.WorkerID, worker); x != nil {
					return x
				}
			}
			if v.ResourceKind == "deliveries" {
				delivery, x := txGet[model.Delivery](tx, "deliveries", v.ResourceID)
				if x != nil {
					return x
				}
				if delivery.AttemptID != v.ID {
					return problem("stale_operation", "delivery has a newer attempt")
				}
				if finalReceipt && delivery.WakeStatus != "sent" && delivery.WakeStatus != "acknowledged" && delivery.WakeStatus != "uncertain" {
					return problem("invalid_state", "delivery wake has no unresolved turn evidence")
				}
				if a.Resolution == "failed" {
					delivery.WakeStatus = "abandoned"
					delivery.Error = a.Reason
				} else {
					delivery.WakeStatus = "resolved"
					if delivery.Status != "acknowledged" && delivery.Status != "consumed" {
						delivery.Status = "delivered"
					}
					if delivery.DeliveredAt == 0 {
						delivery.DeliveredAt = e.now()
					}
					delivery.Error = a.Reason
				}
				delivery.UpdatedAt = e.now()
				if x = tx.Put("deliveries", delivery.ID, delivery); x != nil {
					return x
				}
				if x = tx.Event("delivery.resolved", model.Scope{SessionID: delivery.SessionID, WorkspaceID: delivery.WorkspaceID, RunID: delivery.RunID, WorkerID: delivery.WorkerID}, "human", r.Caller.WorkerID, delivery); x != nil {
					return x
				}
			}
			if v.ResourceKind == "dispatches" {
				dispatch, x := txGet[model.Dispatch](tx, "dispatches", v.ResourceID)
				if x != nil {
					return x
				}
				if activeDispatch(dispatch) && a.Resolution == "failed" {
					dispatch.Status = "failed"
					dispatch.Outcome = a.Reason
					dispatch.SettledAt = e.now()
					if x = tx.Put("dispatches", dispatch.ID, dispatch); x != nil {
						return x
					}
					if x = e.settleRunTx(tx, dispatch); x != nil {
						return x
					}
					if x = tx.Event("dispatch.resolved", dispatchScope(dispatch), "human", r.Caller.WorkerID, dispatch); x != nil {
						return x
					}
				}
			}
			if finalReceipt {
				// Submission/acknowledgment remains an immutable successful receipt.
				// The separately audited wake resolution never fabricates lifecycle
				// evidence or resends that prompt.
				if err = tx.Event("operation.resolved", model.Scope{}, "worker", r.Caller.WorkerID, map[string]any{"operation": v, "resolution": a.Resolution, "reason": a.Reason}); err != nil {
					return err
				}
				return e.finishTx(tx, r.ID, v, nil, "completed")
			}
			v.State = a.Resolution
			v.Error = a.Reason
			v.UpdatedAt = e.now()
			if v.State == "completed" && len(v.Result) == 0 {
				v.Result = json.RawMessage(`{"resolved":true}`)
			}
			if v.State == "failed" {
				v.ErrorCode = "explicitly_failed"
			}
			if err = tx.Put("operations", v.ID, v); err != nil {
				return err
			}
			if err = tx.Event("operation.resolved", model.Scope{}, "worker", r.Caller.WorkerID, v); err != nil {
				return err
			}
			return e.finishTx(tx, r.ID, v, nil, "completed")
		})
		return v, err
	case "daemon.stop":
		return map[string]any{"draining": true, "pid": os.Getpid()}, nil
	}
	return nil, problem("unknown_operation", "%s", r.Op)
}
