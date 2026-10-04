package tui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// Only theme-owned ANSI is generated here. Callers sanitize data before styling;
// the final frame truncates ANSI-aware, rather than stripping these trusted SGRs.
// Basic ANSI colors inherit the operator's terminal palette (light or dark).
// No background is imposed. NO_COLOR/ASCII retain all text and selection markers.
func (m *uiModel) paint(text, role string) string {
	if !m.colors || text == "" {
		return text
	}
	style := lipgloss.NewStyle()
	switch role {
	case "heading", "label":
		style = style.Bold(true)
	case "active":
		style = style.Bold(true).Underline(true).Foreground(lipgloss.Color("5"))
	case "selected":
		style = style.Bold(true).Reverse(true)
	case "success":
		style = style.Foreground(lipgloss.Color("2"))
	case "warning":
		style = style.Bold(true).Foreground(lipgloss.Color("3"))
	case "error":
		style = style.Bold(true).Foreground(lipgloss.Color("1"))
	case "muted":
		style = style.Faint(true)
	default:
		return text
	}
	return style.Render(text)
}

func statusRole(state string) string {
	switch state {
	case "failed", "error", "lost", "rejected":
		return "error"
	case "blocked", "unknown", "uncertain", "open", "held":
		return "warning"
	case "settled", "consumed", "resolved":
		return "success"
	default:
		return ""
	}
}

// Decorate an already-sanitized, wrapped document without adding cells or rows.
// Actual action/state decisions continue to use canonical typed records.
func (m *uiModel) decorate(lines []string, kind string) []string {
	for i, line := range lines {
		if kind == "picker" && strings.HasPrefix(line, "> ") {
			lines[i] = m.paint(line, "selected")
			continue
		}
		if i == 0 && kind != "detail" {
			role := "heading"
			if kind == "review" {
				role = "warning"
			}
			lines[i] = m.paint(line, role)
			continue
		}
		// Occurrence headings keep their state badge colored (settled green,
		// uncertain/blocked yellow, failed red); the text itself is unchanged.
		if kind == "detail" && strings.HasPrefix(line, "Occurrence ") {
			if open, end := strings.Index(line, "["), strings.Index(line, "]"); open > 0 && end > open {
				if role := statusRole(line[open+1 : end]); role != "" {
					lines[i] = m.paint(line[:open], "heading") + m.paint(line[open:end+1], role) + m.paint(line[end+1:], "heading")
					continue
				}
			}
		}
		if kind == "detail" && (strings.HasPrefix(line, "Dispatch ") || strings.HasPrefix(line, "Receipt ") || strings.HasPrefix(line, "Artifact ") || strings.HasPrefix(line, "Worker mailbox") || strings.HasPrefix(line, "Profile ") || strings.HasPrefix(line, "Event ") || strings.HasPrefix(line, "Gate ") || strings.HasPrefix(line, "Schedule ") || strings.HasPrefix(line, "Occurrence ")) {
			lines[i] = m.paint(line, "heading")
			continue
		}
		for _, label := range []string{"State:", "Ready:", "Session:", "Workspace:", "Worktree:", "Run:", "Pane reference:", "Profile:", "Cwd:", "From:", "To:", "Target:", "Frozen scope:", "Subject:", "Context / question:", "Decision:", "Options:", "Tags:", "Agent:", "Literal argv (one argument per line):", "Explicit report:", "Corresponding turn ended:", "Settled at:", "Spec:", "Report body:", "Delivery:", "Persisted:", "Delivered:", "Type:", "Actor:", "Scope:", "Created:", "Artifacts (references only):", "Filter:", "ID:", "Target worker:", "Cron:", "Timezone:", "Missed policy:", "Action:", "Body:", "Handoff:", "Next run:", "Upcoming (schedule zone):", "Recent runs (newest first):", "Currently:", "Keys:", "Schedule:"} {
			if strings.HasPrefix(line, label) {
				role := "label"
				if label == "Target:" || label == "To:" {
					role = "active"
				}
				lines[i] = m.paint(label, role) + strings.TrimPrefix(line, label)
				break
			}
		}
		if strings.HasPrefix(line, "Detail unavailable:") || (strings.HasPrefix(line, "Error:") && strings.TrimSpace(strings.TrimPrefix(line, "Error:")) != "") {
			lines[i] = m.paint(line, "error")
		}
		if kind == "form" && (line == "Subject" || line == "Body" || line == "Artifacts (one path per line)") {
			lines[i] = m.paint(line, "label")
		}
	}
	return lines
}
