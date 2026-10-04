package daemon

import (
	"github.com/zielus/herdr-woof/internal/model"
	"testing"
)

// Adapted from herdr-orch TestPlanHubSlowSubscriberDoesNotBlockOthers.
func TestSlowSubscriberDoesNotBlockHealthySubscriber(t *testing.T) {
	h := newHub()
	slow, closeSlow := h.subscribe()
	defer closeSlow()
	fast, closeFast := h.subscribe()
	defer closeFast()
	for i := int64(1); i < 300; i++ {
		h.publish([]model.Event{{Seq: i}})
		if got := <-fast; got.Seq != i {
			t.Fatalf("got %d want %d", got.Seq, i)
		}
	}
	count := 0
	for range slow {
		count++
	}
	if count != 256 {
		t.Fatalf("slow buffer %d", count)
	}
}
