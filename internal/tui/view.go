package tui

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/zielus/herdr-woof/internal/artifacts"
	"github.com/zielus/herdr-woof/internal/model"
)

type row struct{ ID, Label, State string }

var tabNames = []string{"Workers", "Inbox", "Decisions", "Events", "Profiles", "Schedules"}

// Data text is never terminal markup. Strip sequences before wrapping and remove
// residual controls and bidirectional overrides (including incomplete escapes).
func safeText(s string) string {
	s = ansi.Strip(strings.ToValidUTF8(s, "�"))
	return strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) || r == 0x2028 || r == 0x2029 || unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		return r
	}, s)
}
func inline(s string) string { return strings.ReplaceAll(safeText(s), "\n", " ") }
func (m *uiModel) rowsFor(tab int) []row {
	rows := []row{}
	switch tab {
	case 0:
		for _, w := range m.snapshot.Workers {
			rows = append(rows, row{w.ID, fmt.Sprintf("%s [%s] ready:%t · %s", w.Name, w.State, w.Ready, w.ID), w.State})
		}
	case 1:
		for _, e := range m.snapshot.Inbox {
			rows = append(rows, row{e.Delivery.ID, fmt.Sprintf("%s [%s] %s · %s", e.Message.Kind, e.Delivery.Status, e.Message.Subject, e.Message.ID), e.Delivery.Status})
		}
	case 2:
		for _, g := range m.snapshot.Gates {
			rows = append(rows, row{g.ID, fmt.Sprintf("[%s] %s · %s", g.Status, g.Question, g.ID), g.Status})
		}
	case 3:
		for _, e := range m.snapshot.Events {
			rows = append(rows, row{strconv.FormatInt(e.Seq, 10), fmt.Sprintf("%d %s %s", e.Seq, e.Type, e.ActorID), ""})
		}
	case 4:
		for _, p := range m.snapshot.Profiles {
			rows = append(rows, row{p.Name, p.Name + " [" + p.Agent + "] " + p.Description, ""})
		}
	case scheduleTab:
		for _, sc := range m.snapshot.Schedules {
			enabled, next := "enabled", orDash(sc.NextRunLocal)
			if !sc.Enabled {
				enabled, next = "disabled", "disabled"
			}
			last := "none"
			if sc.LastRun != nil && sc.LastRun.State != "" {
				last = sc.LastRun.State
			}
			rows = append(rows, row{sc.ID, fmt.Sprintf("%s [%s] %s→%s last:%s next:%s · %s", sc.Name, enabled, sc.Action, sc.TargetName, last, next, sc.ID), enabled})
		}
	}
	return rows
}
func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// runStateMeaning keeps persistence, acceptance and settlement distinct.
func runStateMeaning(state string) string {
	switch state {
	case "persisted":
		return "message queued in the worker mailbox; delivery is tracked separately; not completed work"
	case "claimed":
		return "dispatch recorded; no attempt yet"
	case "dispatching":
		return "attempt receipt exists; a prompt may be in progress"
	case "dispatched":
		return "prompt accepted; settlement (done report AND turn-end evidence) shown separately as settled"
	case "settled":
		return "dispatch settled: done report AND matching turn-end evidence; reason is the reported outcome"
	case "uncertain":
		return "prompt outcome unknown; never resent; inspect the attempt operation"
	case "failed":
		return "certain failure"
	case "blocked":
		return "nothing sent; the daemon retries"
	case "skipped":
		return "earlier occurrence still outstanding (overlap; older daemons only)"
	case "missed":
		return "came due while the daemon was not running"
	case "cancelled":
		return "cancelled by disable/remove before any effect"
	}
	return ""
}

// localTime formats a UTC millisecond timestamp in the schedule zone.
func localTime(ms int64, zone string) string {
	if ms == 0 {
		return "-"
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc = time.UTC
	}
	return time.UnixMilli(ms).In(loc).Format(time.RFC3339)
}
func (m *uiModel) scheduleDetailText(id string) string {
	var sc *model.Schedule
	for i := range m.snapshot.Schedules {
		if m.snapshot.Schedules[i].ID == id {
			sc = &m.snapshot.Schedules[i]
		}
	}
	if sc == nil {
		return ""
	}
	var b strings.Builder
	enabled := "enabled"
	if !sc.Enabled {
		enabled = "disabled"
	}
	fmt.Fprintf(&b, "Schedule %s [%s]\nID: %s\nState: %s  revision:%d\nSession: %s\nWorkspace: %s\nWorktree: %s\nTarget worker: %s (%s; fixed at creation, never retargeted)\nCron: %s\nTimezone: %s\nMissed policy: %s\nAction: %s\n", sc.Name, enabled, sc.ID, sc.State, sc.Revision, sc.SessionID, sc.WorkspaceID, orDash(sc.WorktreeID), sc.WorkerID, sc.TargetName, sc.Cron, sc.Timezone, sc.Missed, sc.Action)
	if sc.Action == "dispatch" {
		fmt.Fprintf(&b, "Spec:\n%s\nHandoff: %s\n", sc.Spec, orDash(sc.Handoff))
	} else {
		fmt.Fprintf(&b, "Subject: %s\nBody:\n%s\n", orDash(sc.Subject), sc.Body)
	}
	next := orDash(sc.NextRunLocal)
	if !sc.Enabled {
		next = "disabled"
	}
	fmt.Fprintf(&b, "Next run: %s\n", next)
	detail := m.scheduleDetail
	if detail != nil && (m.scheduleDetailID != id || detail.Schedule.ID != id) {
		detail = nil
	}
	switch {
	case m.scheduleDetailID == id && m.scheduleDetailErr != nil:
		fmt.Fprintf(&b, "Detail unavailable: %s\n", m.scheduleDetailErr)
	case detail != nil && m.err != nil:
		// A failed reload must not leave "refreshing" on screen.
		fmt.Fprintf(&b, "Detail unavailable: STALE, reload failed (%s); showing last read; retrying\n", m.err)
	case m.scheduleDetailID == id && m.scheduleDetailState == "stale":
		b.WriteString("Detail: refreshing after a schedule event…\n")
	case detail == nil || m.scheduleDetailState == "loading" || m.scheduleDetailState == "":
		b.WriteString("Detail: loading…\n")
	}
	if detail != nil {
		b.WriteString("\nUpcoming (schedule zone):\n")
		if len(detail.Upcoming) == 0 {
			b.WriteString("  none (disabled or no future occurrence)\n")
		}
		for i, o := range detail.Upcoming {
			fmt.Fprintf(&b, "  %d. %s\n", i+1, o.Local)
		}
		b.WriteString("\nRecent runs (newest first):\n")
		if len(detail.Runs) == 0 {
			b.WriteString("  none\n")
		}
		for _, v := range detail.Runs {
			r := v.Run
			fmt.Fprintf(&b, "Occurrence %s [%s] trigger:%s\n  Meaning: %s\n  Scheduled for: %s  key:%s  attempts:%d\n", r.ID, r.State, r.Trigger, orDash(runStateMeaning(r.State)), orDash(r.ScheduledForLocal), r.OccurrenceKey, r.Attempts)
			if r.MissedCount > 0 {
				fmt.Fprintf(&b, "  Missed occurrences: %d\n", r.MissedCount)
			}
			if r.SkippedCount > 0 {
				fmt.Fprintf(&b, "  Skipped while outstanding: %d (last due %s); nothing queued for them\n", r.SkippedCount, localTime(r.SkippedLast, sc.Timezone))
			}
			if r.Reason != "" || r.Error != "" {
				fmt.Fprintf(&b, "  Reason: %s  error: %s\n", orDash(r.Reason), orDash(r.Error))
			}
			if r.MessageID != "" {
				fmt.Fprintf(&b, "  Message %s (queued; not completed work)\n", r.MessageID)
			}
			for _, d := range v.Deliveries {
				fmt.Fprintf(&b, "  Delivery %s: %s  wake:%s  acknowledged:%d  consumed:%d\n", d.ID, d.Status, d.WakeStatus, d.AcknowledgedAt, d.ConsumedAt)
			}
			if d := v.Dispatch; d != nil {
				fmt.Fprintf(&b, "  Dispatch %s [%s]  report:%s outcome:%s  turn ended:%t  settled at:%d outcome:%s\n", d.ID, d.Status, orNone(d.DoneMessageID), orDash(d.ReportOutcome), d.TurnEnded, d.SettledAt, orDash(d.Outcome))
			} else if r.DispatchID != "" {
				fmt.Fprintf(&b, "  Dispatch %s\n", r.DispatchID)
			}
			if op := v.Operation; op != nil {
				fmt.Fprintf(&b, "  Attempt operation %s [%s] %s\n", op.ID, op.State, op.Error)
			} else if r.AttemptID != "" {
				fmt.Fprintf(&b, "  Attempt operation %s\n", r.AttemptID)
			}
			if r.State == "uncertain" {
				fmt.Fprintf(&b, "  Never resent. Inspect: woof operation show --id %s\n", orDash(r.AttemptID))
			}
		}
	}
	b.WriteString("\nKeys: e enable · d disable · u run now (each reviewed, submitted once). Add/remove: CLI only (woof schedule add/remove).\n")
	return b.String()
}
func artifactText(statuses []artifacts.FileStatus) string {
	var b strings.Builder
	for _, a := range statuses {
		fmt.Fprintf(&b, "Artifact %s\n  exists:%t readable:%t", a.Path, a.Exists, a.Readable)
		if a.Error != "" {
			fmt.Fprintf(&b, " error:%s", a.Error)
		}
		b.WriteByte('\n')
	}
	return b.String()
}
func receiptText(d model.Delivery) string {
	return fmt.Sprintf("Receipt %s\nDelivery: %s  wake: %s\nPersisted: %d  attempted: %d\nDelivered: %d  acknowledged: %d  consumed: %d\nError: %s\n", d.ID, d.Status, d.WakeStatus, d.CreatedAt, d.AttemptedAt, d.DeliveredAt, d.AcknowledgedAt, d.ConsumedAt, d.Error)
}
func messageText(e InboxEntry) string {
	return fmt.Sprintf("%s [%s] %s\nFrom: %s %s  To: %s %s\nSession: %s  workspace: %s  run: %s\n\n%s\n\n%s%s", e.Message.ID, e.Message.Kind, e.Message.Subject, e.Message.FromKind, e.Message.FromWorkerID, e.Message.ToKind, e.Message.ToID, e.Message.SessionID, e.Message.WorkspaceID, e.Message.RunID, e.Message.Body, receiptText(e.Delivery), artifactText(e.Artifacts))
}
func (m *uiModel) detailText() string {
	id := m.selected[m.tab]
	if id == "" {
		return "Nothing selected"
	}
	var b strings.Builder
	switch m.tab {
	case 0:
		for _, w := range m.snapshot.Workers {
			if w.ID != id {
				continue
			}
			fmt.Fprintf(&b, "%s — %s\nState: %s (raw:%s)\nReady:%t  recovery held:%t  retained:%t\nSession: %s\nWorkspace: %s\nWorktree: %s\nRun: %s\nPane reference: %s  generation:%d\nProfile: %s  agent:%s\nCwd: %s\nError: %s\n", w.ID, w.Name, w.State, w.RawStatus, w.Ready, w.RecoveryHeld, w.Retained, w.SessionID, w.WorkspaceID, w.WorktreeID, w.RunID, w.PaneID, w.Generation, w.ProfileName, w.AgentKind, w.Cwd, w.Error)
			for _, d := range m.snapshot.Dispatches {
				if d.WorkerID != id {
					continue
				}
				fmt.Fprintf(&b, "\nDispatch %s [%s]\nExplicit report: %s  outcome:%s\nCorresponding turn ended: %t (seq:%d)\nSettled at:%d  outcome:%s\nSpec: %s\n", d.ID, d.Status, orNone(d.DoneMessageID), d.ReportOutcome, d.TurnEnded, d.EndSeq, d.SettledAt, d.Outcome, d.Spec)
				if report, ok := m.snapshot.Reports[d.DoneMessageID]; ok {
					fmt.Fprintf(&b, "Report body:\n%s\n%s", report.Message.Body, artifactText(report.Artifacts))
					for _, delivery := range report.Deliveries {
						b.WriteString(receiptText(delivery))
					}
				}
			}
			b.WriteString("\nWorker mailbox (read-only; opening does not acknowledge)\n")
			for _, e := range m.snapshot.WorkerInboxes[id] {
				b.WriteString(messageText(e))
				b.WriteByte('\n')
			}
		}
	case 1:
		for _, e := range m.snapshot.Inbox {
			if e.Delivery.ID == id {
				b.WriteString(messageText(e))
			}
		}
	case 2:
		for _, g := range m.snapshot.Gates {
			if g.ID == id {
				fmt.Fprintf(&b, "Gate %s [%s]\nSession: %s\nWorkspace: %s\nRun: %s\n\n%s\n\nOptions:\n", g.ID, g.Status, g.SessionID, g.WorkspaceID, g.RunID, g.Question)
				for _, o := range g.Options {
					fmt.Fprintf(&b, "  %s\n", o)
				}
				fmt.Fprintf(&b, "Decision: %s\nEnter: review a decision", g.Decision)
			}
		}
	case 3:
		for _, e := range m.snapshot.Events {
			if strconv.FormatInt(e.Seq, 10) == id {
				fmt.Fprintf(&b, "Event %d %s\nType: %s\nActor: %s %s\nScope: %+v\nCreated: %d\n\n%s", e.Seq, e.ID, e.Type, e.ActorKind, e.ActorID, e.Scope, e.CreatedAt, string(e.Payload))
			}
		}
	case scheduleTab:
		b.WriteString(m.scheduleDetailText(id))
	case 4:
		for _, p := range m.snapshot.Profiles {
			if p.Name != id {
				continue
			}
			fmt.Fprintf(&b, "Profile %s\nAgent: %s\n%s\nTags: %s\n\nLiteral argv (one argument per line):\n", p.Name, p.Agent, p.Description, strings.Join(p.Tags, ", "))
			if detail, ok := m.snapshot.ProfileDetails[p.Name]; ok {
				for i, a := range detail.Args {
					fmt.Fprintf(&b, "  [%d] %s\n", i, strconv.Quote(a))
				}
			} else {
				b.WriteString("Launch details unavailable\n")
			}
		}
	}
	return safeText(b.String())
}
func orNone(s string) string {
	if s == "" {
		return "none (waiting)"
	}
	return s
}
func screenLines(s string, width, height, offset int) []string {
	width = max(1, width)
	height = max(1, height)
	wrapped := strings.Split(ansi.Wrap(safeText(s), width, ""), "\n")
	offset = min(max(0, offset), max(0, len(wrapped)-height))
	out := make([]string, height)
	for i := range height {
		if i+offset < len(wrapped) {
			out[i] = ansi.Truncate(wrapped[i+offset], width, "")
		}
	}
	return out
}
func (m *uiModel) listLines(width, height int) []string {
	rows := m.rows()
	out := make([]string, height)
	if len(rows) == 0 {
		out[0] = m.paint("No matching entries", "muted")
		return out
	}
	idx := 0
	for i, r := range rows {
		if r.ID == m.selected[m.tab] {
			idx = i
			break
		}
	}
	start := min(max(0, idx-height+1), max(0, len(rows)-height))
	for i := range height {
		if i+start >= len(rows) {
			break
		}
		r := rows[i+start]
		mark := "  "
		if r.ID == m.selected[m.tab] {
			mark = "> "
		}
		line := mark + inline(r.Label)
		if r.ID == m.selected[m.tab] {
			line = ansi.Truncate(line, width, "…")
			if m.colors {
				line += strings.Repeat(" ", max(0, width-ansi.StringWidth(line)))
			}
			out[i] = m.paint(line, "selected")
		} else {
			badge := "[" + inline(r.State) + "]"
			if r.State != "" {
				line = strings.Replace(line, badge, m.paint(badge, statusRole(r.State)), 1)
			}
			out[i] = ansi.Truncate(line, width, "…")
		}
	}
	return out
}
func (m *uiModel) pickerText(height int) string {
	p := m.picker
	rows := p.visible()
	head := ansi.Truncate(inline(p.title)+"  / filter  Enter pick  Esc back", max(1, m.width), "…") + "\n" + ansi.Truncate("Filter: "+inline(p.filter), max(1, m.width), "…") + "\n"
	if len(rows) == 0 {
		return head + "No matching choices"
	}
	idx := 0
	for i, c := range rows {
		if c.ID == p.selected {
			idx = i
			break
		}
	}
	start := max(0, idx-max(1, height-3)+1)
	var b strings.Builder
	b.WriteString(head)
	for i := start; i < len(rows) && i < start+height-2; i++ {
		mark := "  "
		if rows[i].ID == p.selected {
			mark = "> "
		}
		b.WriteString(ansi.Truncate(mark+inline(rows[i].Label), max(1, m.width), "…") + "\n")
	}
	return b.String()
}
func reviewText(a Action) string {
	if isScheduleKind(a.Kind) {
		return scheduleReviewText(a)
	}
	return fmt.Sprintf("Review %s — Enter confirms; Esc cancels\nFrozen scope: %+v\nTarget: %s  ID: %s\nSubject: %s\nContext / question:\n%s\nDecision: %s\n\n%s\n\nArtifacts (references only):\n%s", a.Kind, a.Scope, a.To, a.ID, a.Subject, a.Label, a.Decision, a.Body, ArtifactReviewText(a))
}

// scheduleReviewText states the frozen schedule identity, target and effect.
func scheduleReviewText(a Action) string {
	sc := model.Schedule{ID: a.ID, Name: a.Label}
	if a.Schedule != nil {
		sc = *a.Schedule
	}
	effect := ""
	switch a.Kind {
	case "schedule.enable":
		effect = "Starts a fresh series from now; disabled-period occurrences are not caught up."
	case "schedule.disable":
		effect = "Stops future occurrences and cancels claimed/blocked ones; a dispatching attempt keeps running to its recorded outcome."
	case "schedule.run":
		effect = "Creates one manual occurrence now and persists a durable message to the target mailbox. Persisted means queued, not completed work."
		if sc.Action == "dispatch" {
			effect = "Creates one manual occurrence now and makes one tracked dispatch attempt; it is blocked with nothing sent if the worker is busy or unverified. Dispatched means the prompt was accepted; settlement still needs a done report and turn-end evidence."
		}
	}
	return fmt.Sprintf("Review %s schedule — Enter confirms; Esc cancels\nSchedule: %s\nID: %s\nAction: %s\nTarget: %s (%s)\nCron: %s  timezone: %s\nCurrently: enabled:%t  next run: %s\nFrozen scope: %+v\n\n%s\n\nSubmitted once. An unknown outcome shows the operation ID and is never resent.", scheduleKinds[a.Kind], sc.Name, sc.ID, sc.Action, a.To, sc.TargetName, sc.Cron, sc.Timezone, sc.Enabled, orDash(sc.NextRunLocal), a.Scope, effect)
}
func (m *uiModel) View() tea.View {
	width, height := max(1, m.width), max(1, m.height)
	var content string
	if width < 60 || height < 16 {
		content = strings.Join(screenLines("Woof needs at least 60 columns × 16 rows. Resize terminal; q quits.", width, height, 0), "\n")
	} else {
		tabs := make([]string, len(tabNames))
		// Narrow terminals keep the active tab readable by shortening the others
		// to their number keys.
		compact := len(strings.Join(tabNames, ""))+len(tabNames)*4 > width
		for i, n := range tabNames {
			tabs[i] = fmt.Sprintf("%d %s", i+1, n)
			if compact && i != m.tab {
				tabs[i] = strconv.Itoa(i + 1)
			}
			if i == m.tab {
				tabs[i] = m.paint("["+tabs[i]+"]", "active")
			}
		}
		status := "LIVE"
		if !m.ready.Load() {
			status = "STALE — actions disabled"
		}
		if m.loading {
			status += " (loading)"
		}
		if m.busy {
			status += " (submitting)"
		}
		statusStyle := "success"
		if !m.ready.Load() {
			statusStyle = "error"
		} else if m.busy {
			statusStyle = "warning"
		}
		header := []string{m.paint("Woof", "heading") + " · human · " + inline(scopeID(m.scope)) + " · " + m.paint(status, statusStyle), strings.Join(tabs, "  "), m.paint("Filter:", "label") + " " + inline(m.filter)}
		errText := ""
		if m.err != nil {
			errText = m.err.Error()
		}
		section := map[int]string{0: "worker_inboxes", 4: "profiles", scheduleTab: "schedules"}[m.tab]
		if section != "" && m.snapshot.Errors[section] != "" {
			errText += " " + section + ": " + m.snapshot.Errors[section]
		}
		if m.tab == 0 && m.snapshot.Errors["reports"] != "" {
			errText += " reports: " + m.snapshot.Errors["reports"]
		}
		header = append(header, m.paint(inline(errText), "error"))
		bodyHeight := height - 6
		var body []string
		switch {
		case m.help:
			body = screenLines("1–6 / Tab tabs; arrows / j,k select; / filter; s choose global/session/workspace/worktree/run; r refresh; Enter detail or gate decision; Esc back; q quit.\n\nWorkers: n message, o ask. Inbox: n recipient picker, o ask, p reply, a acknowledge, x consume. Worker mailbox is read-only.\n\nForm: Tab/Shift+Tab fields; Ctrl+s review. Review: Enter submits once; Esc cancels. PgUp/PgDown scroll.\n\nSchedules (6): read-only except e enable, d disable, u run now; each opens a review. Add/remove stay CLI-only (woof schedule add/remove). Run states: persisted = message queued, not completed work; dispatched = prompt accepted, settlement shown separately; uncertain = never resent, inspect the operation.\n\nAfter an uncertain mutation: i inspect operation; never automatically resend.\n\nSettlement requires an explicit report AND matching turn-end evidence. Delivery, wake, acknowledgment and consumption are separate.", width, bodyHeight, m.scroll)
		case m.picker != nil:
			body = m.decorate(screenLines(m.pickerText(bodyHeight), width, bodyHeight, 0), "picker")
		case m.review != nil:
			body = m.decorate(screenLines(reviewText(*m.review), width, bodyHeight, m.scroll), "review")
		case m.form != nil:
			body = m.decorate(screenLines(m.form.View(width, bodyHeight), width, bodyHeight, 0), "form")
		case m.detail:
			body = m.decorate(screenLines(m.detailText(), width, bodyHeight, m.scroll), "detail")
		case width >= 100:
			leftWidth := width * 2 / 5
			rightWidth := width - leftWidth - 3
			left := m.listLines(leftWidth, bodyHeight)
			right := m.decorate(screenLines(m.detailText(), rightWidth, bodyHeight, m.scroll), "detail")
			body = make([]string, bodyHeight)
			for i := range bodyHeight {
				body[i] = left[i] + strings.Repeat(" ", max(0, leftWidth-lipgloss.Width(left[i]))) + m.paint(" │ ", "muted") + right[i]
			}
		default:
			body = m.listLines(width, bodyHeight)
		}
		lines := append(header, body...)
		noticeRole := "muted"
		if len(m.uncertain) > 0 {
			noticeRole = "warning"
		} else if m.notice == "Action accepted" {
			noticeRole = "success"
		}
		lines = append(lines, m.paint(inline(m.notice), noticeRole), m.paint("1–6/Tab tabs · / filter · s scope · r refresh · ? help · q quit", "muted"))
		for i := range lines {
			lines[i] = ansi.Truncate(lines[i], width, "…")
		}
		content = strings.Join(lines, "\n")
	}
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}
