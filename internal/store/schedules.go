package store

import (
	"context"
	"encoding/json"

	"github.com/zielus/herdr-woof-v2/internal/model"
)

// Schedule history queries adapted from herdr-orch internal/store/schedules.go
// (MIT). Occurrence rows are claimed through Tx.Put with the unique
// (schedule_id, occurrence_key) index; these helpers only read.

// ScheduleRuns returns one schedule's occurrences, newest claim first.
func (s *Store) ScheduleRuns(ctx context.Context, scheduleID string, limit int) ([]model.ScheduleRun, error) {
	if limit <= 0 {
		limit = 20
	}
	return scheduleRuns(ctx, s.db, `SELECT record_json FROM schedule_runs WHERE schedule_id=? ORDER BY json_extract(record_json,'$.claimed_at') DESC, json_extract(record_json,'$.scheduled_for') DESC, id DESC LIMIT ?`, scheduleID, limit)
}

// ScheduleRunsInState returns occurrences in any of states; an empty
// scheduleID selects every schedule.
func (s *Store) ScheduleRunsInState(ctx context.Context, scheduleID string, states ...string) ([]model.ScheduleRun, error) {
	query, args := runsInState(scheduleID, states)
	return scheduleRuns(ctx, s.db, query, args...)
}
func (t *Tx) ScheduleRunsInState(scheduleID string, states ...string) ([]model.ScheduleRun, error) {
	query, args := runsInState(scheduleID, states)
	return scheduleRuns(t.ctx, t.sql, query, args...)
}

func runsInState(scheduleID string, states []string) (string, []any) {
	query := `SELECT record_json FROM schedule_runs WHERE state IN (` + placeholders(len(states)) + `)`
	args := []any{}
	for _, state := range states {
		args = append(args, state)
	}
	if scheduleID != "" {
		query += ` AND schedule_id=?`
		args = append(args, scheduleID)
	}
	return query + ` ORDER BY id`, args
}

func scheduleRuns(ctx context.Context, q queryer, query string, args ...any) (runs []model.ScheduleRun, err error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, databaseError(err)
	}
	defer closeRows(rows, &err)
	runs = []model.ScheduleRun{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var run model.ScheduleRun
		if err := json.Unmarshal(data, &run); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, databaseError(rows.Err())
}
