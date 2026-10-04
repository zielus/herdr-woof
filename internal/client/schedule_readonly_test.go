package client

import "testing"

// Schedule reads may reconnect safely; mutations keep an operation ID so an
// uncertain transport outcome is surfaced instead of replayed.
func TestScheduleReadsAreReadOnlyAndMutationsCarryOperationIDs(t *testing.T) {
	c := &Client{}
	for _, op := range []string{"schedule.list", "schedule.show", "schedule.history"} {
		if !readOnly[op] {
			t.Fatalf("%s is not read-only", op)
		}
		r, err := c.request(op, map[string]any{"id": "sch_1"})
		if err != nil {
			t.Fatal(err)
		}
		if r.ID != "" {
			t.Fatalf("%s carries request ID %q", op, r.ID)
		}
	}
	for _, op := range []string{"schedule.add", "schedule.enable", "schedule.disable", "schedule.remove", "schedule.run"} {
		if readOnly[op] {
			t.Fatalf("%s must not be read-only", op)
		}
		r, err := c.request(op, map[string]any{"id": "sch_1"})
		if err != nil {
			t.Fatal(err)
		}
		if len(r.ID) < 4 || r.ID[:3] != "op_" {
			t.Fatalf("%s request ID = %q", op, r.ID)
		}
	}
}
