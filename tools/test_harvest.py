"""Which media a cart still needs. Run from tools/: python3 -m unittest test_harvest"""

import tempfile
import unittest
from pathlib import Path

import harvest


class TodoFor(unittest.TestCase):
    def test_look_is_skipped_once_recorded_unless_relooked(self):
        root = Path(tempfile.mkdtemp())
        (root / 'wheel').mkdir()
        (root / 'wheel' / 'AAAA0000.png').write_bytes(b'x')
        index = {'AAAA0000': {'look': {'ground': '000000', 'band': None, 'sure': True, 'by': 'analysis'}}}
        wanted = ['wheel', 'look']
        self.assertEqual(harvest.todo_for('AAAA0000', wanted, index, root, relook=False), [])
        self.assertEqual(harvest.todo_for('AAAA0000', wanted, index, root, relook=True), ['look'])
        self.assertEqual(harvest.todo_for('BBBB1111', wanted, index, root, relook=False), ['wheel', 'look'])


if __name__ == '__main__':
    unittest.main()


class WriteIndex(unittest.TestCase):
    def test_the_index_is_compact_and_sorted(self):
        path = Path(tempfile.mkdtemp()) / 'index.json'
        harvest.write_index(path, {'BBBB1111': {'wheel': 'GB/wheel/BBBB1111.png'}, 'AAAA0000': {'look': None}})
        self.assertEqual(
            path.read_text(),
            '{"AAAA0000":{"look":null},"BBBB1111":{"wheel":"GB/wheel/BBBB1111.png"}}',
        )
