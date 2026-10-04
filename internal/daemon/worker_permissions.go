package daemon

import (
	"encoding/json"
	"strings"
)

// Default Woof permissions for workers launched by Woof. This file is the whole
// feature: one fixed list, one opt-out (defaults.worker_permissions: false), no
// per-rule configuration.
//
// Granted, so a worker can run its own coordination flow without a prompt or a
// sandbox failure on every command:
//   - claude: Bash allow rules for the commands in claudeAllowed, passed with
//     --settings, which merges with the user's own settings. The rules are
//     prefix text matches on the command line. They are a convenience, not a
//     security boundary, and cannot scope recipients (`woof send` reaches any
//     worker). Starting, adopting, stopping or releasing workers, dispatching,
//     nudging or failing another worker's dispatch, schedules, gates, sessions,
//     operation resolution and daemon control stay behind Claude's own prompt.
//   - codex: a permission profile extending :workspace that may connect to the
//     woofd Unix socket through Codex's limited network proxy, plus --no-daemon
//     so tool commands keep this pane's WOOF_* identity. Other network access
//     and the Herdr socket stay blocked.
//
// Limitation: the Codex grant is per socket, not per subcommand. A Codex worker
// holding it can run every woof command, including worker start/stop and
// schedule changes. Codex cannot narrow that for a single launch.
//
// A launch whose own arguments already choose permissions is left untouched.
var claudeAllowed = []string{
	"woof inbox", "woof message show", "woof message ack", "woof message consume",
	"woof ack", "woof consume", "woof reply",
	"woof dispatch show", "woof dispatch check", "woof done",
	"woof worker show", "woof status", "woof operation show",
	"woof wait", "woof question wait", "woof events list", "woof events follow",
	"woof send", "woof ask",
}

// workerPermissionArgs returns the launch arguments to put before the profile
// and --arg arguments, or nil when nothing should be added. sock is the socket
// woofd listens on, which may be the short /tmp fallback.
func workerPermissionArgs(kind string, args []string, sock string) []string {
	switch kind {
	case "claude":
		if claudeChoosesPermissions(args) {
			return nil
		}
		rules := make([]string, len(claudeAllowed))
		for i, command := range claudeAllowed {
			rules[i] = "Bash(" + command + " *)"
		}
		settings, err := json.Marshal(map[string]any{"permissions": map[string]any{"allow": rules}})
		if err != nil {
			return nil
		}
		return []string{"--settings", string(settings)}
	case "codex":
		// The path is embedded in a TOML string; refuse what would need escaping.
		if sock == "" || strings.ContainsFunc(sock, func(r rune) bool { return r == '"' || r == '\\' || r < 0x20 || r == 0x7f }) {
			return nil
		}
		noDaemon, chooses := codexChoosesPermissions(args)
		if chooses {
			return nil
		}
		// network.enabled=true without the network_proxy feature would open all
		// network access, so the two are only ever emitted together. The table
		// must be one inline TOML value for the -c parser.
		out := []string{"--enable", "network_proxy",
			"-c", `permissions.woof={extends=":workspace",network={enabled=true,mode="limited",unix_sockets={"` + sock + `"="allow"}}}`,
			"-c", `default_permissions="woof"`}
		if !noDaemon {
			out = append([]string{"--no-daemon"}, out...)
		}
		return out
	}
	return nil
}

// flagValue splits args[i] into its flag name and value, taking the value from
// --flag=value or from the next argument.
func flagValue(args []string, i int) (name, value string) {
	name, value, ok := strings.Cut(args[i], "=")
	if !ok && i+1 < len(args) {
		value = args[i+1]
	}
	return name, value
}

func claudeChoosesPermissions(args []string) bool {
	for i := range args {
		switch name, value := flagValue(args, i); name {
		case "--settings", "--allowedTools", "--allowed-tools", "--dangerously-skip-permissions":
			return true
		case "--permission-mode":
			if value == "bypassPermissions" {
				return true
			}
		}
	}
	return false
}

func codexChoosesPermissions(args []string) (noDaemon, chooses bool) {
	for i, arg := range args {
		switch name, value := flagValue(args, i); name {
		case "--no-daemon":
			noDaemon = true
		case "--sandbox", "-s", "--dangerously-bypass-approvals-and-sandbox", "--yolo":
			return noDaemon, true
		case "--disable":
			if value == "network_proxy" {
				return noDaemon, true
			}
		case "-c", "--config":
			key, _, _ := strings.Cut(value, "=")
			if strings.Contains(key, "permissions") || strings.Contains(key, "sandbox_") || strings.Contains(key, "network_proxy") {
				return noDaemon, true
			}
		default:
			if strings.HasPrefix(arg, "-s") && !strings.HasPrefix(arg, "--") {
				return noDaemon, true
			}
		}
	}
	return noDaemon, false
}
