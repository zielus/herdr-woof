// Package cli translates agent-friendly commands to the global daemon RPC.
package cli

import (
	"fmt"
	"github.com/zielus/herdr-woof-v2/internal/model"
	"strconv"
	"strings"
	"time"
)

// Args mirrors the RPC payload without importing the daemon/store into the CLI.
type Args struct {
	ID         string   `json:"id,omitempty"`
	Name       string   `json:"name,omitempty"`
	Profile    string   `json:"profile,omitempty"`
	Pane       string   `json:"pane,omitempty"`
	Socket     string   `json:"socket,omitempty"`
	HerdrName  string   `json:"herdr_name,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	Workspace  string   `json:"workspace,omitempty"`
	Worktree   string   `json:"worktree,omitempty"`
	To         string   `json:"to,omitempty"`
	Subject    string   `json:"subject,omitempty"`
	Body       string   `json:"body,omitempty"`
	Question   string   `json:"question,omitempty"`
	Kind       string   `json:"kind,omitempty"`
	Title      string   `json:"title,omitempty"`
	Spec       string   `json:"spec,omitempty"`
	Handoff    string   `json:"handoff,omitempty"`
	Dispatch   string   `json:"dispatch,omitempty"`
	Attachment string   `json:"attachment,omitempty"`
	Outcome    string   `json:"outcome,omitempty"`
	Reason     string   `json:"reason,omitempty"`
	Decision   string   `json:"decision,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Artifacts  []string `json:"artifacts,omitempty"`
	ExtraArgs  []string `json:"extra_args,omitempty"`
	Options    []string `json:"options,omitempty"`
	Events     []string `json:"events,omitempty"`
	Retained   bool     `json:"retained,omitempty"`
	Force      bool     `json:"force,omitempty"`
	All        bool     `json:"all,omitempty"`
	Since      *int64   `json:"since,omitempty"`
	Limit      int      `json:"limit,omitempty"`
	Lines      int      `json:"lines,omitempty"`
	Timeout    int64    `json:"timeout_ms,omitempty"`
	Cron       string   `json:"cron,omitempty"`
	Timezone   string   `json:"timezone,omitempty"`
	Missed     string   `json:"missed,omitempty"`
	Disabled   bool     `json:"disabled,omitempty"`
}
type Command struct {
	Op                         string
	Args                       Args
	JSON, Help, Follow, NoWait bool
	Explicit                   model.Scope
	HasScope                   bool
	AsWorker, AsAttachment     string
}

var commands = map[string]string{
	"tui": "tui", "status": "status", "version": "version", "session attach": "session.attach", "session list": "session.list", "workspace list": "workspace.list", "worktree list": "worktree.list",
	"worker spawn": "worker.spawn", "worker start": "worker.spawn", "worker adopt": "worker.adopt", "worker register": "worker.adopt", "worker show": "worker.show", "worker list": "worker.list", "workers": "worker.list", "worker retain": "worker.retain", "worker release": "worker.release", "worker stop": "worker.stop", "worker read": "worker.read",
	"run create": "run.create", "run show": "run.show", "run list": "run.list", "send": "send", "ask": "ask", "reply": "reply", "inbox": "inbox", "ack": "ack", "consume": "consume", "message show": "message.show", "message ack": "ack", "message consume": "consume", "question wait": "question.wait",
	"dispatch": "dispatch", "dispatch show": "dispatch.show", "dispatch check": "check", "dispatch nudge": "nudge", "dispatch fail": "fail", "done": "done", "check": "check", "nudge": "nudge", "fail": "fail",
	"gate create": "gate.create", "gate list": "gate.list", "gate show": "gate.show", "gate resolve": "gate.resolve", "gates create": "gate.create", "gates list": "gate.list", "gates show": "gate.show", "gates resolve": "gate.resolve",
	"operation list": "operation.list", "operation show": "operation.show", "operation resolve": "operation.resolve", "events": "events.list", "events list": "events.list", "events follow": "events.follow", "events wait": "wait", "wait": "wait", "profile roster": "profile.roster", "profile list": "profile.roster", "profile show": "profile.show", "daemon stop": "daemon.stop", "daemon restart": "daemon.restart",
}
var allowed = map[string]string{
	"session.attach": "socket herdr-name name", "worker.spawn": "name profile pane cwd herdr-workspace retained arg", "worker.adopt": "id worker name pane cwd", "worker.show": "id worker", "worker.read": "id worker lines", "worker.list": "all", "worker.retain": "id worker retained off", "worker.release": "id worker force", "worker.stop": "id worker force",
	"run.create": "title kind", "run.show": "id", "send": "to subject body kind artifact", "ask": "to subject body question artifact timeout no-wait", "reply": "id body artifact", "inbox": "id all limit", "ack": "id", "consume": "id", "message.show": "id", "question.wait": "id timeout",
	"dispatch": "to worker spec handoff", "dispatch.show": "id", "done": "dispatch attachment body artifact failed outcome", "nudge": "id dispatch reason", "fail": "id dispatch reason", "gate.create": "question options option", "gate.show": "id", "gate.resolve": "id decision", "operation.show": "id", "operation.resolve": "id resolution reason",
	"events.list": "events since limit", "events.follow": "events since", "wait": "events since timeout",
	"profile.show": "id name",
}
var boolean = map[string]bool{"json": true, "help": true, "global": true, "force": true, "retained": true, "all": true, "failed": true, "off": true, "no-wait": true, "version": true}
var scopeKeys = map[string]bool{"session": true, "workspace": true, "worktree": true, "run": true, "worker-scope": true, "global": true}
var valued = map[string]bool{"arg": true, "as-worker": true, "as-attachment": true, "id": true, "name": true, "profile": true, "pane": true, "socket": true, "herdr-name": true, "cwd": true, "herdr-workspace": true, "worker": true, "to": true, "subject": true, "body": true, "question": true, "kind": true, "title": true, "spec": true, "handoff": true, "dispatch": true, "attachment": true, "outcome": true, "reason": true, "decision": true, "resolution": true, "artifact": true, "options": true, "option": true, "events": true, "since": true, "limit": true, "lines": true, "timeout": true, "session": true, "workspace": true, "worktree": true, "run": true, "worker-scope": true}

func Parse(argv []string) (Command, error) {
	var c Command
	flags := map[string][]string{}
	var words []string
	if len(argv) == 0 {
		return Command{Help: true}, nil
	}
	for _, arg := range argv {
		if arg == "--help" || arg == "-h" {
			return Command{Help: true}, nil
		}
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			words = append(words, argv[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") {
			words = append(words, arg)
			continue
		}
		if !strings.HasPrefix(arg, "--") {
			return c, fmt.Errorf("unknown option %q; use --help", arg)
		}
		key, value, eq := strings.Cut(arg[2:], "=")
		if boolean[key] {
			if !eq {
				value = "true"
			}
			if _, err := strconv.ParseBool(value); err != nil {
				return c, fmt.Errorf("--%s needs true or false", key)
			}
		} else if valued[key] {
			if !eq {
				i++
				if i >= len(argv) {
					return c, fmt.Errorf("--%s needs a value", key)
				}
				value = argv[i]
			}
		} else {
			return c, fmt.Errorf("unknown option --%s", key)
		}
		flags[key] = append(flags[key], value)
	}
	if len(flags["version"]) > 0 {
		return Command{Op: "version", JSON: containsJSON(argv)}, nil
	}
	if len(words) == 0 {
		return c, fmt.Errorf("command required; use --help")
	}
	key := words[0]
	used := 1
	if len(words) > 1 {
		if _, ok := commands[key+" "+words[1]]; ok {
			key += " " + words[1]
			used = 2
		}
	}
	op, ok := commands[key]
	if !ok {
		return c, fmt.Errorf("unknown command %q; use --help", key)
	}
	c.Op = op
	c.Follow = op == "events.follow"
	get := func(k string) string {
		xs := flags[k]
		if len(xs) > 0 {
			return xs[len(xs)-1]
		}
		return ""
	}
	isTrue := func(k string) bool { v, _ := strconv.ParseBool(get(k)); return v }
	for k := range flags {
		if k == "json" || k == "as-worker" || k == "as-attachment" || scopeKeys[k] {
			continue
		}
		if !strings.Contains(" "+allowed[op]+" ", " "+k+" ") {
			return c, fmt.Errorf("--%s is not valid for %s", k, key)
		}
	}
	c.JSON = isTrue("json")
	c.AsWorker, c.AsAttachment = get("as-worker"), get("as-attachment")
	if op == "tui" && (c.JSON || len(flags["as-worker"]) > 0 || len(flags["as-attachment"]) > 0) {
		return c, fmt.Errorf("tui is an interactive human interface; --json and actor overrides are not supported")
	}
	if len(flags["as-worker"]) > 0 || len(flags["as-attachment"]) > 0 {
		if strings.TrimSpace(c.AsWorker) == "" || strings.TrimSpace(c.AsAttachment) == "" {
			return c, fmt.Errorf("--as-worker and --as-attachment must be supplied together with nonempty IDs")
		}
	}
	c.Explicit = model.Scope{SessionID: get("session"), WorkspaceID: get("workspace"), WorktreeID: get("worktree"), RunID: get("run"), WorkerID: get("worker-scope"), Global: isTrue("global")}
	for k := range scopeKeys {
		if _, ok := flags[k]; ok {
			c.HasScope = true
			if k != "global" && get(k) == "" {
				return c, fmt.Errorf("--%s needs a nonempty scope ID", k)
			}
		}
	}
	if c.Explicit.Global && (c.Explicit.SessionID != "" || c.Explicit.WorkspaceID != "" || c.Explicit.WorktreeID != "" || c.Explicit.RunID != "" || c.Explicit.WorkerID != "") {
		return c, fmt.Errorf("--global cannot be combined with scope IDs")
	}
	a := Args{ID: get("id"), Name: get("name"), Profile: get("profile"), Pane: get("pane"), Socket: get("socket"), HerdrName: get("herdr-name"), Cwd: get("cwd"), Workspace: get("herdr-workspace"), To: get("to"), Subject: get("subject"), Body: get("body"), Question: get("question"), Kind: get("kind"), Title: get("title"), Spec: get("spec"), Handoff: get("handoff"), Dispatch: get("dispatch"), Attachment: get("attachment"), Outcome: get("outcome"), Reason: get("reason"), Decision: get("decision"), Resolution: get("resolution"), Artifacts: flags["artifact"], ExtraArgs: flags["arg"], Retained: isTrue("retained"), Force: isTrue("force"), All: isTrue("all")}
	for _, arg := range a.ExtraArgs {
		if strings.ContainsRune(arg, 0) {
			return c, fmt.Errorf("--arg cannot contain NUL")
		}
	}
	if op == "session.attach" && a.HerdrName == "" {
		a.HerdrName = a.Name
		a.Name = ""
	}
	if op == "profile.show" && a.ID == "" {
		a.ID = a.Name
	}
	if strings.HasPrefix(op, "worker.") && a.ID == "" {
		a.ID = get("worker")
	}
	if op == "worker.retain" {
		a.Retained = !isTrue("off")
		if _, ok := flags["retained"]; ok {
			a.Retained = isTrue("retained")
		}
	}
	if op == "dispatch" && a.To == "" {
		a.To = get("worker")
	}
	if (op == "nudge" || op == "fail") && a.ID == "" {
		a.ID = a.Dispatch
	}
	if isTrue("failed") {
		a.Outcome = "failed"
	}
	if op == "ask" {
		if a.Body == "" {
			a.Body = a.Question
		}
		c.NoWait = isTrue("no-wait")
	}
	split := func(s string) []string {
		var out []string
		for _, x := range strings.Split(s, ",") {
			if x = strings.TrimSpace(x); x != "" {
				out = append(out, x)
			}
		}
		return out
	}
	a.Options = append(split(get("options")), flags["option"]...)
	a.Events = split(get("events"))
	if value := get("since"); value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 0 {
			return c, fmt.Errorf("--since requires a nonnegative event cursor")
		}
		a.Since = &n
	}
	for _, pair := range []struct {
		key string
		dst *int
	}{{"limit", &a.Limit}, {"lines", &a.Lines}} {
		if value := get(pair.key); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil || n <= 0 {
				return c, fmt.Errorf("--%s requires a positive integer", pair.key)
			}
			*pair.dst = n
		}
	}
	if value := get("timeout"); value != "" {
		duration, err := time.ParseDuration(value)
		if err != nil || duration < time.Millisecond {
			return c, fmt.Errorf("--timeout needs a positive duration such as 20m or 30s")
		}
		a.Timeout = duration.Milliseconds()
	}
	rest := words[used:]
	if len(rest) > 0 {
		idCommand := strings.Contains(" worker.show worker.read worker.retain worker.release worker.stop run.show reply ack consume message.show question.wait dispatch.show nudge fail gate.show gate.resolve operation.show operation.resolve profile.show ", " "+op+" ")
		if len(rest) != 1 || !idCommand || a.ID != "" {
			return c, fmt.Errorf("unexpected arguments for %s: %s", key, strings.Join(rest, " "))
		}
		a.ID = rest[0]
	}
	needs := func(label, value string) error {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s requires --%s", key, label)
		}
		return nil
	}
	var requirements [][2]string
	switch op {
	case "send":
		requirements = [][2]string{{"to", a.To}, {"body", a.Body}}
	case "ask":
		requirements = [][2]string{{"to", a.To}, {"question", a.Body}}
	case "reply":
		requirements = [][2]string{{"id", a.ID}, {"body", a.Body}}
	case "dispatch":
		requirements = [][2]string{{"to", a.To}}
		if a.Spec == "" && a.Handoff == "" {
			return c, fmt.Errorf("dispatch requires --spec or --handoff")
		}
	case "done":
		requirements = [][2]string{{"dispatch", a.Dispatch}, {"attachment", a.Attachment}, {"body", a.Body}}
	case "gate.create":
		requirements = [][2]string{{"question", a.Question}}
	case "gate.resolve":
		requirements = [][2]string{{"id", a.ID}, {"decision", a.Decision}}
	case "operation.resolve":
		requirements = [][2]string{{"id", a.ID}, {"resolution", a.Resolution}, {"reason", a.Reason}}
		if a.Resolution != "completed" && a.Resolution != "failed" {
			return c, fmt.Errorf("--resolution must be completed or failed after investigation")
		}
	case "worker.adopt":
		requirements = [][2]string{{"pane", a.Pane}}
		if a.ID == "" {
			requirements = append(requirements, [2]string{"name", a.Name})
		}
	case "worker.spawn":
		requirements = [][2]string{{"name", a.Name}}
	case "fail":
		requirements = [][2]string{{"id", a.ID}, {"reason", a.Reason}}
	case "worker.show", "worker.read", "worker.retain", "worker.release", "worker.stop", "run.show", "ack", "consume", "message.show", "question.wait", "dispatch.show", "nudge", "gate.show", "operation.show", "profile.show":
		requirements = [][2]string{{"id", a.ID}}
	}
	for _, req := range requirements {
		if err := needs(req[0], req[1]); err != nil {
			return c, err
		}
	}
	c.Args = a
	return c, nil
}

func (c Command) ApplyScope(inherited model.Scope) model.Scope {
	if c.HasScope {
		return c.Explicit
	}
	return inherited
}
