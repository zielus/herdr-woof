package daemon

// Adapted from herdr-orch's planHub (MIT, Stephen Ellington).
import (
	"github.com/zielus/herdr-woof-v2/internal/model"
	"sync"
)

type hub struct {
	mu   sync.Mutex
	subs map[chan model.Event]struct{}
}

func newHub() *hub { return &hub{subs: map[chan model.Event]struct{}{}} }
func (h *hub) subscribe() (<-chan model.Event, func()) {
	ch := make(chan model.Event, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
	}
}
func (h *hub) publish(events []model.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		for _, ev := range events {
			select {
			case ch <- ev:
			default:
				delete(h.subs, ch)
				close(ch)
			}
			if _, ok := h.subs[ch]; !ok {
				break
			}
		}
	}
}
