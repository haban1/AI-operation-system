// Package session reconciles client state with the protocol's login state.
// The protocol alone owns heartbeat retries and automatic authentication.
package session

import (
	"context"
	"errors"
	"sync"
	"time"
)

type Hooks struct {
	Probe          func(context.Context) error
	StartHeartbeat func(context.Context) error
	StopHeartbeat  func(context.Context) error
	Logout         func(context.Context) error
	SaveStopped    func(context.Context, bool) error
	Online         func(context.Context) error
	Offline        func(context.Context) error
}

type Manager struct {
	mu             sync.Mutex
	hooks          Hooks
	online         bool
	stopped        bool
	closed         bool
	probing        bool
	generation     uint64
	failures       int
	offlinePending bool
	cancel         context.CancelFunc
	done           chan struct{}
}

func New(hooks Hooks, stopped bool) *Manager {
	return &Manager{hooks: hooks, stopped: stopped}
}

// Restore preserves the persisted manual logout intent across process restarts.
func (m *Manager) Restore(ctx context.Context) error {
	m.mu.Lock()
	err := m.hooks.Offline(ctx)
	m.offlinePending = err != nil
	stopped := m.stopped
	if stopped {
		// Reassert a manual stop if the previous protocol shutdown was interrupted.
		err = errors.Join(err, m.hooks.StopHeartbeat(ctx))
	}
	m.mu.Unlock()
	if err != nil || stopped {
		return err
	}
	if online, _ := m.Check(ctx); online {
		return nil
	}
	// A client restart must not leave an existing session with heartbeats disabled.
	// This is a single start request, not a second authentication/retry loop.
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped || m.closed {
		return nil
	}
	return m.hooks.StartHeartbeat(ctx)
}

// Online is called only after an explicit login succeeds.
func (m *Manager) Online(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return context.Canceled
	}
	m.generation++
	if err := m.hooks.SaveStopped(ctx, false); err != nil {
		return err
	}
	m.stopped = false
	m.failures = 0
	return m.onlineLocked(ctx)
}

func (m *Manager) onlineLocked(ctx context.Context) error {
	if m.online {
		return nil
	}
	if err := m.hooks.StartHeartbeat(ctx); err != nil {
		return err
	}
	if err := m.hooks.Online(ctx); err != nil {
		return err
	}
	m.online = true
	m.offlinePending = false
	return nil
}

// Offline never disables the protocol's retry loop, even for repeated callbacks.
func (m *Manager) Offline(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.generation++
	m.failures = 0
	m.online = false
	err := m.hooks.Offline(ctx)
	m.offlinePending = err != nil
	return err
}

// Check coalesces concurrent probes. An old result cannot override a newer
// callback, successful login or manual logout. A single network error is not a logout.
func (m *Manager) Check(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m.mu.Lock()
	if m.stopped || m.closed || m.probing {
		online := m.online && !m.stopped && !m.closed
		m.mu.Unlock()
		return online, nil
	}
	m.probing = true
	generation := m.generation
	m.mu.Unlock()

	err := m.hooks.Probe(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.probing = false
	if generation != m.generation || m.stopped || m.closed {
		return m.online && !m.stopped && !m.closed, nil
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return false, err
		}
		m.failures++
		if m.offlinePending || (m.failures >= 3 && m.online) {
			m.online = false
			statusErr := m.hooks.Offline(ctx)
			m.offlinePending = statusErr != nil
			err = errors.Join(err, statusErr)
		}
		return false, err
	}
	m.failures = 0
	err = m.onlineLocked(ctx)
	return m.online, err
}

// Logout is the only path that stops protocol heartbeats. Even if persisting or
// updating status fails, still attempt both heartbeat shutdown and protocol logout.
func (m *Manager) Logout(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generation++
	m.stopped = true
	m.online = false
	m.failures = 0
	return errors.Join(m.hooks.SaveStopped(ctx, true), m.hooks.StopHeartbeat(ctx),
		m.hooks.Offline(ctx), m.hooks.Logout(ctx))
}

func (m *Manager) Start(interval time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil || m.closed {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.done = make(chan struct{})
	go func() {
		defer close(m.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
				_, _ = m.Check(probeCtx)
				cancel()
			}
		}
	}()
}

func (m *Manager) Name() string { return "微信会话状态检查" }

// Shutdown stops only the local monitor, preserving protocol retries on deploy.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	m.generation++
	if m.cancel != nil {
		m.cancel()
	}
	done := m.done
	m.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
