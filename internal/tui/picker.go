package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/zielus/herdr-woof-v2/internal/model"
)

// Picker navigation and filter/Escape behavior adapt herdr-projects/src/popup.rs.
// Choices carry durable database IDs rather than file slugs or pane references.
type choice struct {
	ID, Label string
	Scope     model.Scope
	Worker    *model.Worker
}
type picker struct {
	title            string
	choices          []choice
	selected, filter string
	filtering        bool
	recipientKind    string
}

func newPicker(title string, choices []choice, selected string) *picker {
	p := &picker{title: title, choices: choices, selected: selected}
	p.ensure()
	return p
}
func (p *picker) visible() []choice {
	out := make([]choice, 0, len(p.choices))
	for _, c := range p.choices {
		if strings.Contains(strings.ToLower(c.Label+" "+c.ID), strings.ToLower(p.filter)) {
			out = append(out, c)
		}
	}
	return out
}
func (p *picker) ensure() {
	rows := p.visible()
	for _, c := range rows {
		if c.ID == p.selected {
			return
		}
	}
	p.selected = ""
	if len(rows) > 0 {
		p.selected = rows[0].ID
	}
}
func (p *picker) move(delta int) {
	rows := p.visible()
	if len(rows) == 0 {
		return
	}
	idx := 0
	for i, c := range rows {
		if c.ID == p.selected {
			idx = i
			break
		}
	}
	p.selected = rows[(idx+delta+len(rows))%len(rows)].ID
}
func (p *picker) update(msg tea.KeyPressMsg) (*choice, bool) {
	k := msg.String()
	switch k {
	case "esc":
		if p.filter != "" {
			p.filter = ""
			p.filtering = false
			p.ensure()
			return nil, false
		}
		return nil, true
	case "enter":
		for _, c := range p.visible() {
			if c.ID == p.selected {
				return &c, true
			}
		}
	case "down":
		p.move(1)
	case "up":
		p.move(-1)
	case "backspace":
		if p.filtering {
			r := []rune(p.filter)
			if len(r) > 0 {
				p.filter = string(r[:len(r)-1])
			}
			p.ensure()
		}
	default:
		if p.filtering {
			if msg.Text != "" {
				p.filter += safeText(msg.Text)
				p.ensure()
			}
		} else {
			switch k {
			case "/":
				p.filtering = true
			case "j":
				p.move(1)
			case "k":
				p.move(-1)
			}
		}
	}
	return nil, false
}
func scopeChoices(s Snapshot) []choice {
	out := []choice{{ID: "global", Label: "Global", Scope: model.Scope{Global: true}}}
	for _, v := range s.Sessions {
		out = append(out, choice{ID: v.ID, Label: "Session " + v.HerdrName + " " + v.ID, Scope: model.Scope{SessionID: v.ID}})
	}
	for _, v := range s.Workspaces {
		out = append(out, choice{ID: v.ID, Label: "Workspace " + v.Name + " " + v.ID, Scope: model.Scope{SessionID: v.SessionID, WorkspaceID: v.ID}})
	}
	for _, v := range s.Worktrees {
		out = append(out, choice{ID: v.ID, Label: "Worktree " + v.Path + " " + v.ID, Scope: model.Scope{SessionID: v.SessionID, WorkspaceID: v.WorkspaceID, WorktreeID: v.ID}})
	}
	for _, v := range s.Runs {
		out = append(out, choice{ID: v.ID, Label: "Run " + v.Title + " " + v.ID, Scope: model.Scope{SessionID: v.SessionID, WorkspaceID: v.WorkspaceID, WorktreeID: v.WorktreeID, RunID: v.ID}})
	}
	return out
}
func scopeID(s model.Scope) string {
	switch {
	case s.WorkerID != "":
		return s.WorkerID
	case s.RunID != "":
		return s.RunID
	case s.WorktreeID != "":
		return s.WorktreeID
	case s.WorkspaceID != "":
		return s.WorkspaceID
	case s.SessionID != "":
		return s.SessionID
	default:
		return "global"
	}
}
