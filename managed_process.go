package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const managedLeaseFD = 3
const managedStatusFD = 4

type managedCommand struct {
	cmd       *exec.Cmd
	actualPID int
	lease     *os.File
	done      chan error
	stopOnce  sync.Once
}

func startManagedCommand(
	root, command string,
	extraEnv []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) (*managedCommand, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate pum executable: %w", err)
	}
	leaseRead, leaseWrite, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("create process lease: %w", err)
	}
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		leaseRead.Close()
		leaseWrite.Close()
		return nil, fmt.Errorf("create process status pipe: %w", err)
	}

	cmd := exec.Command(executable, "_exec", root, command)
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.ExtraFiles = []*os.File{leaseRead, statusWrite}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		leaseRead.Close()
		leaseWrite.Close()
		statusRead.Close()
		statusWrite.Close()
		return nil, err
	}
	leaseRead.Close()
	statusWrite.Close()

	pidLine, readErr := bufio.NewReader(statusRead).ReadString('\n')
	statusRead.Close()
	actualPID, parseErr := strconv.Atoi(strings.TrimSpace(pidLine))
	if readErr != nil || parseErr != nil || actualPID <= 0 {
		_ = leaseWrite.Close()
		waitErr := cmd.Wait()
		if readErr != nil {
			return nil, fmt.Errorf("process supervisor did not report its child: %w", readErr)
		}
		if parseErr != nil {
			return nil, fmt.Errorf("process supervisor reported an invalid child pid: %w", parseErr)
		}
		return nil, fmt.Errorf("process supervisor exited before starting its child: %v", waitErr)
	}

	process := &managedCommand{
		cmd:       cmd,
		actualPID: actualPID,
		lease:     leaseWrite,
		done:      make(chan error, 1),
	}
	go func() {
		waitErr := cmd.Wait()
		// If the supervisor or command leader was killed, descendants may still
		// occupy the command's process group. Always sweep it before publishing
		// completion.
		_ = syscall.Kill(-process.actualPID, syscall.SIGKILL)
		process.done <- waitErr
		close(process.done)
		process.stopOnce.Do(func() {
			_ = process.lease.Close()
		})
	}()
	return process, nil
}

func (p *managedCommand) stop(force bool) {
	p.stopOnce.Do(func() {
		command := byte('T')
		if force {
			command = 'K'
		}
		_, _ = p.lease.Write([]byte{command})
		_ = p.lease.Close()
	})
}

func runExecSupervisor(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "pum: invalid internal process-supervisor invocation")
		return 2
	}
	root, command := args[0], args[1]
	lease := os.NewFile(managedLeaseFD, "pum-daemon-lease")
	if lease == nil {
		fmt.Fprintln(os.Stderr, "pum: process supervisor has no daemon lease")
		return 125
	}
	defer lease.Close()
	syscall.CloseOnExec(managedLeaseFD)
	status := os.NewFile(managedStatusFD, "pum-command-status")
	if status == nil {
		fmt.Fprintln(os.Stderr, "pum: process supervisor has no status channel")
		return 125
	}
	defer status.Close()
	syscall.CloseOnExec(managedStatusFD)

	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = root
	cmd.Env = os.Environ()
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "pum: start managed command: %v\n", err)
		return 126
	}
	if _, err := fmt.Fprintf(status, "%d\n", cmd.Process.Pid); err != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		return 125
	}
	_ = status.Close()

	commandDone := make(chan error, 1)
	go func() { commandDone <- cmd.Wait() }()
	control := make(chan byte, 1)
	go func() {
		var buffer [1]byte
		n, err := lease.Read(buffer[:])
		if n == 1 {
			control <- buffer[0]
			return
		}
		if err != nil || n == 0 {
			control <- 'K'
		}
	}()

	select {
	case err := <-commandDone:
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		return commandExitCode(err)
	case action := <-control:
		signal := syscall.SIGTERM
		grace := 3 * time.Second
		if action != 'T' {
			signal = syscall.SIGKILL
			grace = 250 * time.Millisecond
		}
		_ = syscall.Kill(-cmd.Process.Pid, signal)
		select {
		case <-commandDone:
		case <-time.After(grace):
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-commandDone
		}
		if action == 'T' {
			return 143
		}
		return 137
	}
}

func commandExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code := exitErr.ExitCode(); code >= 0 {
			return code
		}
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
	}
	if strings.Contains(err.Error(), "signal:") {
		return 128
	}
	return 1
}
