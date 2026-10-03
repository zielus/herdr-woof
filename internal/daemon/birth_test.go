package daemon

import (
	"os"
	"testing"
)

func TestControllingTerminalLossDoesNotProveDeath(t *testing.T) {
	id, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	id.TTY = "previous-terminal"
	if !originalProcessAlive(id) {
		t.Fatal("same PID/birth was declared dead due to changed TTY")
	}
	id.Birth = "obsolete"
	if originalProcessAlive(id) {
		t.Fatal("PID reuse was treated as original process")
	}
}
func TestProcessBirthUsesKernelIdentity(t *testing.T) {
	id, err := birthIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	kernel, err := kernelBirth(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if id.Birth != kernel {
		t.Fatal("process identity did not use precise kernel birth")
	}
}
