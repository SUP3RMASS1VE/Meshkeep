"""The internal server must not expose the retired browser launch mode."""
import subprocess
import sys
import unittest
from pathlib import Path


class DesktopStartupTests(unittest.TestCase):
    def test_direct_start_explains_desktop_launch(self):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'app.py')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Launch the Meshkeep desktop application', result.stderr)
        self.assertNotIn('READY_URL', result.stdout)

    def test_browser_switch_is_removed(self):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'app.py'), '--help'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('--no-browser', result.stdout)
