package main

import (
	"errors"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

type supervisor struct {
	mu sync.Mutex

	gatewayArgs []string
	state       supervisorState
	cmd         *exec.Cmd
	startedAt   time.Time
	exitWait    chan struct{}

	autoRestart   bool
	stopRequested bool
	shuttingDown  bool

	backoff      time.Duration
	restartTimer *time.Timer
	restarts     int
	lastExit     *lastExit
}

func newSupervisor(gatewayArgs []string) *supervisor {
	return &supervisor{
		gatewayArgs: gatewayArgs,
		state:       stateStopped,
		autoRestart: true,
		backoff:     backoffInitial,
	}
}

func (s *supervisor) Start() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.shuttingDown {
		return false, errors.New("gateway is shutting down")
	}
	if s.state == stateRunning || s.state == stateStarting || s.state == stateStopping {
		return false, nil
	}

	s.autoRestart = true
	s.stopRequested = false
	s.cancelRestartLocked()
	s.backoff = backoffInitial

	if err := s.startLocked(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *supervisor) Stop() (bool, error) {
	s.mu.Lock()
	s.autoRestart = false
	s.stopRequested = true
	s.cancelRestartLocked()

	cmd := s.cmd
	waitCh := s.exitWait
	if cmd == nil {
		s.state = stateStopped
		s.mu.Unlock()
		return false, nil
	}
	s.state = stateStopping
	s.mu.Unlock()

	if err := signalProcess(cmd, syscall.SIGTERM); err != nil {
		return false, err
	}
	waitForExit(waitCh, cmd)
	return true, nil
}

func (s *supervisor) Restart() (bool, error) {
	if _, err := s.Stop(); err != nil {
		return false, err
	}
	return s.Start()
}

func (s *supervisor) Shutdown(sig os.Signal) error {
	s.mu.Lock()
	s.shuttingDown = true
	s.state = stateShuttingDown
	s.autoRestart = false
	s.stopRequested = true
	s.cancelRestartLocked()

	cmd := s.cmd
	waitCh := s.exitWait
	s.mu.Unlock()

	if cmd == nil {
		return nil
	}
	if err := signalProcess(cmd, sig); err != nil {
		return err
	}
	waitForExit(waitCh, cmd)
	return nil
}

func (s *supervisor) Stats() supervisorStats {
	s.mu.Lock()
	defer s.mu.Unlock()

	var pid *int
	if s.cmd != nil && s.cmd.Process != nil {
		v := s.cmd.Process.Pid
		pid = &v
	}

	var uptime int64
	if !s.startedAt.IsZero() {
		uptime = int64(time.Since(s.startedAt).Seconds())
	}

	return supervisorStats{
		State:    s.state,
		Pid:      pid,
		Uptime:   uptime,
		Restarts: s.restarts,
		LastExit: s.lastExit,
	}
}

func (s *supervisor) startLocked() error {
	args := append([]string{"gateway"}, s.gatewayArgs...)

	cmd := exec.Command("openclaw", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	s.state = stateStarting
	if err := cmd.Start(); err != nil {
		s.state = stateStopped
		return err
	}

	s.cmd = cmd
	s.startedAt = time.Now()
	s.state = stateRunning

	exitCh := make(chan struct{})
	s.exitWait = exitCh
	go s.waitForProcess(cmd, s.startedAt, exitCh)
	return nil
}

func (s *supervisor) waitForProcess(cmd *exec.Cmd, startedAt time.Time, exitCh chan struct{}) {
	err := cmd.Wait()
	close(exitCh)

	codePtr, signalName := exitDetails(err)
	finishedAt := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cmd != cmd {
		return
	}

	if time.Since(startedAt) >= healthyThreshold {
		s.backoff = backoffInitial
	}

	s.lastExit = &lastExit{
		Code:   codePtr,
		Signal: signalName,
		At:     finishedAt.UTC().Format(time.RFC3339),
	}
	s.cmd = nil
	s.startedAt = time.Time{}
	s.exitWait = nil

	if s.shuttingDown {
		s.state = stateShuttingDown
		return
	}
	if s.stopRequested || !s.autoRestart {
		s.state = stateStopped
		s.stopRequested = false
		return
	}

	s.state = stateCrashed
	s.restarts++
	delay := s.backoff
	s.backoff = minDuration(backoffMax, s.backoff*backoffMultiplier)
	s.restartTimer = time.AfterFunc(delay, func() {
		s.restartAfterBackoff()
	})
}

func (s *supervisor) restartAfterBackoff() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.restartTimer = nil
	if s.shuttingDown || !s.autoRestart || s.stopRequested || s.cmd != nil {
		return
	}

	if err := s.startLocked(); err != nil {
		log.Printf("[controller-go] restart spawn failed: %v", err)
		s.state = stateCrashed
		delay := s.backoff
		s.backoff = minDuration(backoffMax, s.backoff*backoffMultiplier)
		s.restartTimer = time.AfterFunc(delay, func() {
			s.restartAfterBackoff()
		})
	}
}

func (s *supervisor) cancelRestartLocked() {
	if s.restartTimer != nil {
		s.restartTimer.Stop()
		s.restartTimer = nil
	}
}

func waitForExit(waitCh chan struct{}, cmd *exec.Cmd) {
	if waitCh != nil {
		select {
		case <-waitCh:
			return
		case <-time.After(shutdownTimeout):
		}
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func signalProcess(cmd *exec.Cmd, sig os.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := cmd.Process.Signal(sig); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func exitDetails(err error) (*int, string) {
	if err == nil {
		v := 0
		return &v, ""
	}

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return nil, ""
	}
	ws, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return nil, ""
	}

	if ws.Exited() {
		v := ws.ExitStatus()
		return &v, ""
	}
	if ws.Signaled() {
		return nil, ws.Signal().String()
	}
	return nil, ""
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
