package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScheduleCommandMapping(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		op   string
	}{
		{[]string{"schedule", "add", "--name", "n", "--to", "w", "--cron", "0 9 * * *", "--body", "hi"}, "schedule.add"},
		{[]string{"schedule", "list"}, "schedule.list"},
		{[]string{"schedules"}, "schedule.list"},
		{[]string{"schedule", "show", "sch_1"}, "schedule.show"},
		{[]string{"schedule", "history", "sch_1"}, "schedule.history"},
		{[]string{"schedule", "enable", "sch_1"}, "schedule.enable"},
		{[]string{"schedule", "disable", "sch_1"}, "schedule.disable"},
		{[]string{"schedule", "remove", "sch_1"}, "schedule.remove"},
		{[]string{"schedule", "rm", "sch_1"}, "schedule.remove"},
		{[]string{"schedule", "run", "sch_1"}, "schedule.run"},
	} {
		c, err := Parse(tc.argv)
		if err != nil {
			t.Fatalf("%q: %v", tc.argv, err)
		}
		if c.Op != tc.op {
			t.Fatalf("%q: op=%s want %s", tc.argv, c.Op, tc.op)
		}
	}
	if _, err := Parse([]string{"schedule"}); err == nil {
		t.Fatal("accepted bare schedule")
	}
}

func TestScheduleIDPositionalAndNameAlias(t *testing.T) {
	for _, sub := range []string{"show", "history", "enable", "disable", "remove", "rm", "run"} {
		c, err := Parse([]string{"schedule", sub, "sch_1"})
		if err != nil || c.Args.ID != "sch_1" {
			t.Fatalf("%s positional: %+v %v", sub, c.Args, err)
		}
		c, err = Parse([]string{"schedule", sub, "--id", "sch_2"})
		if err != nil || c.Args.ID != "sch_2" {
			t.Fatalf("%s --id: %+v %v", sub, c.Args, err)
		}
		c, err = Parse([]string{"schedule", sub, "--name", "nightly"})
		if err != nil || c.Args.ID != "nightly" || c.Args.Name != "" {
			t.Fatalf("%s --name: %+v %v", sub, c.Args, err)
		}
		if _, err := Parse([]string{"schedule", sub}); err == nil || !strings.Contains(err.Error(), "requires --id") {
			t.Fatalf("%s without ID: %v", sub, err)
		}
		if _, err := Parse([]string{"schedule", sub, "a", "b"}); err == nil {
			t.Fatalf("%s accepted two positionals", sub)
		}
		if _, err := Parse([]string{"schedule", sub, "--id", "a", "b"}); err == nil {
			t.Fatalf("%s accepted --id plus positional", sub)
		}
	}
	if _, err := Parse([]string{"schedule", "list", "sch_1"}); err == nil {
		t.Fatal("schedule list accepted a positional")
	}
	if _, err := Parse([]string{"schedule", "add", "sch_1", "--name", "n", "--to", "w", "--every", "1m", "--body", "x"}); err == nil {
		t.Fatal("schedule add accepted a positional")
	}
	c, err := Parse([]string{"schedule", "history", "sch_1", "--limit", "5"})
	if err != nil || c.Args.Limit != 5 {
		t.Fatalf("history limit: %+v %v", c.Args, err)
	}
	c, err = Parse([]string{"schedule", "list", "--all"})
	if err != nil || !c.Args.All {
		t.Fatalf("list --all: %+v %v", c.Args, err)
	}
}

func TestScheduleAddPayload(t *testing.T) {
	c, err := Parse([]string{"schedule", "add", "--name", "standup", "--to", "worker:w_1", "--every", " 90m ", "--tz", "Europe/Warsaw", "--subject", "s", "--body", "status please", "--missed", "skip", "--disabled", "--json", "--session", "s_1", "--workspace", "ws_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !c.JSON || !c.HasScope || c.Explicit.SessionID != "s_1" || c.Explicit.WorkspaceID != "ws_1" {
		t.Fatalf("command=%+v", c)
	}
	b, err := json.Marshal(c.Args)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"name": "standup", "to": "worker:w_1", "cron": "@every 90m", "timezone": "Europe/Warsaw", "subject": "s", "body": "status please", "missed": "skip", "disabled": true}
	for k, v := range want {
		if payload[k] != v {
			t.Fatalf("payload[%s]=%v want %v (payload %s)", k, payload[k], v, b)
		}
	}
	if len(payload) != len(want) {
		t.Fatalf("unexpected payload keys: %s", b)
	}

	c, err = Parse([]string{"schedule", "add", "--name", "n", "--to", "w", "--cron", "*/5 * * * *", "--spec", "do it"})
	if err != nil || c.Args.Cron != "*/5 * * * *" || c.Args.Spec != "do it" || c.Args.Missed != "" || c.Args.Disabled {
		t.Fatalf("cron dispatch: %+v %v", c.Args, err)
	}
	c, err = Parse([]string{"schedule", "add", "--name", "n", "--to", "w", "--cron", "@daily", "--handoff", "./h.md", "--missed", "latest"})
	if err != nil || c.Args.Handoff != "./h.md" || c.Args.Spec != "" || c.Args.Missed != "latest" {
		t.Fatalf("handoff-only dispatch: %+v %v", c.Args, err)
	}
	c, err = Parse([]string{"schedule", "add", "--name", "n", "--to", "w", "--every", "1s", "--spec", "x", "--handoff", "./h.md"})
	if err != nil || c.Args.Cron != "@every 1s" {
		t.Fatalf("spec+handoff: %+v %v", c.Args, err)
	}
}

func TestScheduleAddValidation(t *testing.T) {
	base := func(extra ...string) []string {
		return append([]string{"schedule", "add"}, extra...)
	}
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{base("--to", "w", "--every", "1m", "--body", "x"), "requires --name"},
		{base("--name", "n", "--every", "1m", "--body", "x"), "requires --to"},
		{base("--name", "n", "--to", "w", "--body", "x"), "--cron EXPR or --every"},
		{base("--name", "n", "--to", "w", "--cron", "@daily", "--every", "1m", "--body", "x"), "only one of --cron or --every"},
		{base("--name", "n", "--to", "w", "--cron=", "--every", "1m", "--body", "x"), "only one of --cron or --every"},
		{base("--name", "n", "--to", "w", "--cron", " ", "--body", "x"), "--cron needs"},
		{base("--name", "n", "--to", "w", "--every", "500ms", "--body", "x"), "at least 1s"},
		{base("--name", "n", "--to", "w", "--every", "0", "--body", "x"), "at least 1s"},
		{base("--name", "n", "--to", "w", "--every", "-5m", "--body", "x"), "at least 1s"},
		{base("--name", "n", "--to", "w", "--every", "soon", "--body", "x"), "at least 1s"},
		{base("--name", "n", "--to", "w", "--every", "1m"), "requires --body (message) or --spec/--handoff (dispatch)"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--subject", "s"), "requires --body (message) or --spec/--handoff (dispatch)"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--spec", "y"), "not both"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--handoff", "h.md"), "not both"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--subject", "s", "--spec", "y"), "--subject applies only"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--subject", "s", "--handoff", "h.md"), "--subject applies only"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", " "), "--body needs"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--spec", ""), "nonempty --spec or --handoff"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--missed", "all"), "--missed must be latest or skip"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--missed="), "--missed must be latest or skip"},
		{base("--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--disabled=maybe"), "--disabled needs true or false"},
		{base("--name", "n", "--to", "w", "--every"), "--every needs a value"},
	} {
		_, err := Parse(tc.argv)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%q: err=%v want %q", tc.argv, err, tc.want)
		}
	}
}

func TestScheduleRejectsForeignFlags(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		flag string
	}{
		{[]string{"schedule", "list", "--cron", "@daily"}, "cron"},
		{[]string{"schedule", "list", "--every", "1m"}, "every"},
		{[]string{"schedule", "list", "--tz", "UTC"}, "tz"},
		{[]string{"schedule", "list", "--missed", "skip"}, "missed"},
		{[]string{"schedule", "list", "--disabled"}, "disabled"},
		{[]string{"schedule", "list", "--limit", "3"}, "limit"},
		{[]string{"schedule", "show", "x", "--limit", "3"}, "limit"},
		{[]string{"schedule", "show", "x", "--cron", "@daily"}, "cron"},
		{[]string{"schedule", "history", "x", "--all"}, "all"},
		{[]string{"schedule", "enable", "x", "--disabled"}, "disabled"},
		{[]string{"schedule", "disable", "x", "--force"}, "force"},
		{[]string{"schedule", "remove", "x", "--force"}, "force"},
		{[]string{"schedule", "run", "x", "--body", "y"}, "body"},
		{[]string{"schedule", "add", "--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--artifact", "a"}, "artifact"},
		{[]string{"schedule", "add", "--name", "n", "--to", "w", "--every", "1m", "--body", "x", "--id", "a"}, "id"},
		{[]string{"send", "--to", "w", "--body", "x", "--cron", "@daily"}, "cron"},
		{[]string{"dispatch", "--to", "w", "--spec", "x", "--disabled"}, "disabled"},
	} {
		_, err := Parse(tc.argv)
		if err == nil || !strings.Contains(err.Error(), "--"+tc.flag+" is not valid for") {
			t.Fatalf("%q: err=%v", tc.argv, err)
		}
	}
}

func TestScheduleAcceptsJSONAndScope(t *testing.T) {
	for _, argv := range [][]string{
		{"schedule", "list", "--json", "--session", "s_1"},
		{"schedules", "--workspace", "ws_1", "--json"},
		{"schedule", "show", "sch_1", "--json", "--workspace", "ws_1"},
		{"schedule", "run", "--name", "nightly", "--session", "s_1", "--json"},
		{"--global", "schedule", "list", "--all"},
	} {
		c, err := Parse(argv)
		if err != nil || !c.HasScope {
			t.Fatalf("%q: %+v %v", argv, c, err)
		}
		if strings.Contains(strings.Join(argv, " "), "--json") && !c.JSON {
			t.Fatalf("%q: lost --json", argv)
		}
	}
}

func TestHelpDocumentsSchedules(t *testing.T) {
	for _, want := range []string{"schedule add --name NAME --to WORKER", "--every 30m", "--missed latest|skip", "schedule list [--all]", "history ID [--limit N]", "remove ID | run ID"} {
		if !strings.Contains(Help, want) {
			t.Fatalf("help lacks %q", want)
		}
	}
}
