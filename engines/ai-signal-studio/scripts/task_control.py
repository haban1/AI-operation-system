"""Run one generation in a process whose media subprocesses can be stopped."""
import multiprocessing
import os
import signal
import subprocess
import threading
import time


class ProgressDict(dict):
    def __init__(self, value, connection):
        super().__init__(value)
        self.connection = connection
        self.guard = threading.Lock()

    def update(self, *args, **kwargs):
        with self.guard:
            super().update(*args, **kwargs)
            self.connection.send(dict(self))

    def __setitem__(self, key, value):
        self.update({key: value})


def execute(connection, worker, arguments):
    if os.name == 'posix':
        os.setsid()
    try:
        worker(*arguments, connection)
    finally:
        connection.close()


def stop_tree(process, force=False):
    if os.name == 'posix':
        try:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            if process.is_alive():
                process.kill() if force else process.terminate()
    elif process.is_alive():
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


class TaskControl:
    def __init__(self):
        self.guard = threading.RLock()
        self.active = False
        self.cancelled = False
        self.process = None
        self.started_at = None

    def prepare(self, started_at):
        with self.guard:
            self.active = True
            self.cancelled = False
            self.process = None
            self.started_at = started_at

    def cancel(self, started_at, on_cancel):
        with self.guard:
            if not self.active or self.started_at != started_at:
                return False
            self.cancelled = True
            on_cancel()
            if self.process:
                stop_tree(self.process)
            return True

    def run(self, worker, arguments, on_state, on_finish):
        context = multiprocessing.get_context('spawn')
        reader, writer = context.Pipe(duplex=False)
        process = context.Process(target=execute, args=(writer, worker, arguments), daemon=True)
        started = False
        try:
            with self.guard:
                if not self.cancelled:
                    process.start()
                    started = True
                    self.process = process
            writer.close()
            cancel_time = None
            while started:
                if reader.poll(.1):
                    try:
                        state = reader.recv()
                    except EOFError:
                        break
                    with self.guard:
                        if not self.cancelled:
                            on_state(state)
                if self.cancelled:
                    cancel_time = cancel_time or time.monotonic()
                    stop_tree(process, force=time.monotonic() - cancel_time > 1)
                if not process.is_alive() and not reader.poll():
                    break
            if started:
                process.join(timeout=2)
                if self.cancelled or process.is_alive():
                    stop_tree(process, force=True)
                    process.join(timeout=2)
        finally:
            writer.close()
            reader.close()
            with self.guard:
                try:
                    on_finish(self.cancelled)
                finally:
                    self.active = False
                    self.process = None
