package daemon

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"time"
)

// OSNotify posts one local desktop notification, best effort. Title and body
// are passed as arguments, never interpolated into a script or a shell, and a
// notification banner does not take focus.
func OSNotify(ctx context.Context, title, body string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	switch runtime.GOOS {
	case "darwin":
		return exec.CommandContext(ctx, "/usr/bin/osascript",
			"-e", "on run argv",
			"-e", "display notification (item 2 of argv) with title (item 1 of argv)",
			"-e", "end run", title, body).Run()
	case "linux":
		bin, err := exec.LookPath("notify-send")
		if err != nil {
			return err
		}
		return exec.CommandContext(ctx, bin, "--", title, body).Run()
	}
	return errors.New("no OS notification fallback on " + runtime.GOOS)
}
