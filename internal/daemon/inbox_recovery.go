package daemon

import (
	"context"
	"strings"
	"time"

	"github.com/zielus/herdr-woof-v2/internal/model"
	"github.com/zielus/herdr-woof-v2/internal/store"
)

const inboxReadFailure = "held: readiness read failed: "
const inboxReadRetryInterval = time.Second

// Only an original, unattempted delivery can enter watchdog read recovery.
// An accepted or uncertain external mutation is never eligible for replay.
func inboxReadRecoverable(d model.Delivery) bool {
	return !d.Human && d.WorkerID != "" && d.WakeStatus == "queued" &&
		d.AcknowledgedAt == 0 && d.ConsumedAt == 0 && d.AttemptID == "" &&
		d.AttemptedAt == 0 && strings.HasPrefix(d.Error, inboxReadFailure)
}

// This is recovery from a failed readiness read, not tick-driven progression.
// Each worker has one tracked recovery task, and UpdatedAt throttles repeated
// failures even when the same durable hold reason would otherwise be unchanged.
func (e *Engine) recoverInboxReads(ctx context.Context, deliveries []model.Delivery) error {
	workers := map[string]bool{}
	now := e.now()
	for _, d := range deliveries {
		if inboxReadRecoverable(d) && now-d.UpdatedAt >= inboxReadRetryInterval.Milliseconds() {
			workers[d.WorkerID] = true
		}
	}
	for workerID := range workers {
		if ctx.Err() != nil || e.ctx.Err() != nil {
			return ctx.Err()
		}
		key := "inbox-read-recovery:" + workerID
		if _, loaded := e.inFlight.LoadOrStore(key, true); loaded {
			continue
		}
		scheduled := false
		err := e.write(ctx, func(tx *store.Tx) error {
			w, err := txGet[model.Worker](tx, "workers", workerID)
			if err != nil {
				return err
			}
			if terminalRecipient(w) || w.State == "lost" || w.State == "offline" {
				return nil
			}
			ds, err := txList[model.Delivery](tx, "deliveries", model.Scope{WorkerID: workerID})
			if err != nil {
				return err
			}
			for _, d := range ds {
				if !inboxReadRecoverable(d) || now-d.UpdatedAt < inboxReadRetryInterval.Milliseconds() {
					continue
				}
				d.UpdatedAt = now
				if err := tx.Put("deliveries", d.ID, d); err != nil {
					return err
				}
				if err := tx.Event("delivery.read_recovery", workerScope(w), "daemon", "", map[string]string{"delivery_id": d.ID}); err != nil {
					return err
				}
				scheduled = true
			}
			return nil
		})
		if err != nil || !scheduled {
			e.inFlight.Delete(key)
			if err != nil {
				return err
			}
			continue
		}
		e.background(func() {
			defer e.inFlight.Delete(key)
			e.processInbox(workerID, true)
		})
		// If shutdown rejected registration, no task remains to release the key.
		// Cancellation also prevents any new recovery ticks from scheduling work.
		if e.ctx.Err() != nil {
			e.inFlight.Delete(key)
		}
	}
	return nil
}
