package session

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fixture struct {
	starts, stops, logouts, online, offline int
	stopped                                 bool
	probeErr, persistErr, onlineErr         error
	manager                                 *Manager
}

func newFixture(stopped bool) *fixture {
	f := &fixture{stopped: stopped}
	f.manager = New(Hooks{
		Probe:          func(context.Context) error { return f.probeErr },
		StartHeartbeat: func(context.Context) error { f.starts++; return nil },
		StopHeartbeat:  func(context.Context) error { f.stops++; return nil },
		Logout:         func(context.Context) error { f.logouts++; return nil },
		SaveStopped:    func(_ context.Context, stopped bool) error { f.stopped = stopped; return f.persistErr },
		Online:         func(context.Context) error { f.online++; return f.onlineErr },
		Offline:        func(context.Context) error { f.offline++; return nil },
	}, stopped)
	return f
}

func TestDisconnectPreservesHeartbeatAndRecoveryRunsOnce(t *testing.T) {
	f := newFixture(false)
	ctx := context.Background()
	if err := f.manager.Online(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.Offline(ctx); err != nil {
		t.Fatal(err)
	}
	f.probeErr = errors.New("session temporarily unavailable")
	for range 4 {
		_, _ = f.manager.Check(ctx)
	}
	if f.stops != 0 || f.logouts != 0 {
		t.Fatal("disconnect disabled protocol recovery")
	}
	f.probeErr = nil
	for range 3 {
		if online, err := f.manager.Check(ctx); !online || err != nil {
			t.Fatalf("recovery: %v %v", online, err)
		}
	}
	if f.online != 2 || f.starts != 2 {
		t.Fatalf("duplicate background workers: online=%d starts=%d", f.online, f.starts)
	}
}

func TestFailedProbesDoNotStopHeartbeat(t *testing.T) {
	f := newFixture(false)
	ctx := context.Background()
	_ = f.manager.Online(ctx)
	f.probeErr = errors.New("timeout")
	_, _ = f.manager.Check(ctx)
	if f.offline != 0 {
		t.Fatal("one failed probe marked session offline")
	}
	_, _ = f.manager.Check(ctx)
	_, _ = f.manager.Check(ctx)
	if f.offline != 1 || f.stops != 0 {
		t.Fatal("failed probes must mark offline without stopping retries")
	}
}

func TestManualLogoutPersistsAndIgnoresStaleProbe(t *testing.T) {
	f := newFixture(false)
	ctx := context.Background()
	_ = f.manager.Online(ctx)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f.manager.hooks.Probe = func(context.Context) error { close(entered); <-release; return nil }
	go func() { defer close(done); _, _ = f.manager.Check(ctx) }()
	<-entered
	if err := f.manager.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	_ = f.manager.Offline(ctx) // a late protocol callback cannot undo logout intent
	if online, _ := f.manager.Check(ctx); online {
		t.Fatal("stale probe restored deliberate logout")
	}
	if !f.stopped || f.stops != 1 || f.logouts != 1 || f.starts != 1 {
		t.Fatal("logout did not stop recovery")
	}
	if err := f.manager.Online(ctx); err != nil {
		t.Fatal(err)
	}
	if f.stopped || f.starts != 2 {
		t.Fatal("explicit login did not resume recovery")
	}
}

func TestRestartPreservesManualLogout(t *testing.T) {
	f := newFixture(true)
	if err := f.manager.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.starts != 0 || f.online != 0 || f.offline != 1 {
		t.Fatal("restart resumed deliberately stopped session")
	}
}

func TestRestartWithExpiredSessionKeepsRetryEnabled(t *testing.T) {
	f := newFixture(false)
	f.probeErr = errors.New("session expired")
	if err := f.manager.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.starts != 1 || f.stops != 0 || f.online != 0 {
		t.Fatal("restart disabled recovery")
	}
}

func TestLogoutStillStopsProtocolIfPersistenceFails(t *testing.T) {
	f := newFixture(false)
	f.persistErr = errors.New("redis down")
	if err := f.manager.Logout(context.Background()); err == nil {
		t.Fatal("missing persistence error")
	}
	if f.stops != 1 || f.logouts != 1 {
		t.Fatal("persistence failure skipped protocol logout")
	}
}

func TestStatusUpdateFailureIsRetried(t *testing.T) {
	f := newFixture(false)
	f.onlineErr = errors.New("database unavailable")
	if online, err := f.manager.Check(context.Background()); online || err == nil {
		t.Fatal("false success")
	}
	f.onlineErr = nil
	if online, err := f.manager.Check(context.Background()); !online || err != nil {
		t.Fatal("status not retried")
	}
}

func TestLateProbeCannotOverrideOfflineCallback(t *testing.T) {
	f := newFixture(false)
	ctx := context.Background()
	_ = f.manager.Online(ctx)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f.manager.hooks.Probe = func(context.Context) error { close(entered); <-release; return nil }
	go func() { defer close(done); _, _ = f.manager.Check(ctx) }()
	<-entered
	_ = f.manager.Offline(ctx)
	close(release)
	<-done
	if f.manager.online || f.online != 1 {
		t.Fatal("stale probe overrode disconnect callback")
	}
}

func TestMonitorRecoversWithoutBrowserAndStopsOnShutdown(t *testing.T) {
	f := newFixture(false)
	recovered := make(chan struct{}, 10)
	f.manager.hooks.Online = func(context.Context) error { recovered <- struct{}{}; return nil }
	f.manager.Start(time.Millisecond)
	select {
	case <-recovered:
	case <-time.After(time.Second):
		t.Fatal("monitor never recovered session")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.manager.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if f.stops != 0 || f.logouts != 0 {
		t.Fatal("client shutdown stopped protocol")
	}
	if online, _ := f.manager.Check(ctx); online {
		t.Fatal("monitor resumed after shutdown")
	}
}
