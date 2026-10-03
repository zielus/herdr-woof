package daemon

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func checkCleanup(t *testing.T, err error) {
	t.Helper()
	if err != nil && !errors.Is(err, net.ErrClosed) {
		t.Errorf("fixture cleanup: %v", err)
	}
}

func stopTestProcess(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	// Some retirement tests have already waited for this process to exit.
	if cmd.ProcessState != nil {
		return
	}
	killTestProcess(t, cmd.Process)
	// A killed fixture normally reports an ExitError; unexpected wait failures
	// still indicate broken cleanup and must be visible.
	var exitErr *exec.ExitError
	if err := cmd.Wait(); err != nil && !errors.As(err, &exitErr) {
		t.Errorf("wait for fixture process: %v", err)
	}
}

func killTestProcess(t *testing.T, p *os.Process) {
	t.Helper()
	if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH) {
		t.Errorf("stop fixture process: %v", err)
	}
}
