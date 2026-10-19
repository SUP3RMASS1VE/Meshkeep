"""Portable polling watcher. Only explicitly selected folders are monitored."""
import os
import threading
import time

from library import SKIP, under
import formats
from file_state import file_stat, is_link


class FolderWatcher:
    def __init__(self, library, root, interval=15):
        self.library, self.root, self.interval = library, root, interval
        self.stop_event = threading.Event()
        self.snapshots = {}
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, daemon=True, name='meshkeep-watcher')
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                # A temporarily unavailable database must not kill monitoring.
                pass
            self.stop_event.wait(self.interval)

    def tick(self):
        with self.library.connect() as db:
            watches = db.execute('SELECT path FROM watched_folders WHERE enabled=1').fetchall()
        active = {r['path'] for r in watches}
        self.snapshots = {key: value for key, value in self.snapshots.items() if key in active}
        for row in watches:
            path = row['path']
            if not under(os.path.realpath(path), self.root):
                continue
            try:
                if not os.path.isdir(path):
                    raise OSError('Folder is unavailable. It will be retried automatically.')
                snapshot = {}
                def fail(error):
                    raise error
                for folder, dirs, files in os.walk(path, followlinks=False, onerror=fail):
                    if self.stop_event.is_set():
                        return
                    dirs[:] = [d for d in dirs if not d.startswith('.') and d not in SKIP and not is_link(os.path.join(folder, d))]
                    for name in files:
                        if name.startswith('.') or os.path.splitext(name)[1].lower() not in formats.EXTENSIONS:
                            continue
                        item = os.path.join(folder, name)
                        if is_link(item):
                            continue
                        st = file_stat(item)
                        snapshot[item] = (st.st_size, st.st_mtime_ns, st.st_ctime_ns)
                result = None
                if snapshot != self.snapshots.get(path):
                    if self.library.scan_lock.locked():
                        continue
                    result = self.library.scan(path, lambda *a: None)
                    self.snapshots[path] = snapshot
                with self.library.connect() as db:
                    db.execute('UPDATE watched_folders SET checked=?,error=? WHERE path=?', (time.time(), (str(result['errorCount'])+' metadata errors') if result and result['errorCount'] else None, path))
                    if result:
                        db.execute('UPDATE watched_folders SET indexed=?,changed=? WHERE path=?', (result['indexed'], time.time(), path))
            except Exception as exc:
                with self.library.connect() as db:
                    db.execute('UPDATE watched_folders SET checked=?,error=? WHERE path=?', (time.time(), str(exc), path))
