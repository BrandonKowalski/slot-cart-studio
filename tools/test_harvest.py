"""Which media a cart still needs. Run from tools/: python3 -m unittest test_harvest"""

import json
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



class WriteIndex(unittest.TestCase):
    def test_the_index_is_compact_and_sorted(self):
        path = Path(tempfile.mkdtemp()) / 'index.json'
        harvest.write_index(path, {'BBBB1111': {'wheel': 'GB/wheel/BBBB1111.png'}, 'AAAA0000': {'look': None}})
        self.assertEqual(
            path.read_text(),
            '{"AAAA0000":{"look":null},"BBBB1111":{"wheel":"GB/wheel/BBBB1111.png"}}',
        )


class RegionsFor(unittest.TestCase):
    def test_a_dump_prefers_its_own_region(self):
        self.assertEqual(harvest.regions_for('Metroid Fusion (USA)'), ('us', 'wor', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (USA, Australia)'), ('us', 'wor', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (Japan)'), ('jp', 'us', 'wor', 'eu'))
        self.assertEqual(harvest.regions_for('Metroid Fusion (Europe) (En,Fr,De,Es,It)'), ('eu', 'us', 'wor', 'jp'))
        self.assertEqual(harvest.regions_for('Pokemon - Gelbe Edition (Germany)'), ('de', 'eu', 'us', 'wor', 'jp'))
        self.assertEqual(harvest.regions_for('Tetris (World) (Rev 1)'), ('wor', 'us', 'eu', 'jp'))
        self.assertEqual(harvest.regions_for('E60EC183'), ('us', 'wor', 'eu', 'jp'))

    def test_pick_follows_the_order_it_is_given(self):
        medias = [{'type': 'wheel', 'region': 'us', 'url': 'u'}, {'type': 'wheel', 'region': 'jp', 'url': 'j'}]
        self.assertEqual(harvest.pick(medias, 'wheel')['url'], 'u')
        self.assertEqual(harvest.pick(medias, 'wheel', harvest.regions_for('X (Japan)'))['url'], 'j')
        self.assertEqual(harvest.pick(medias, 'wheel', harvest.regions_for('X (France)'))['url'], 'u')


class Redo(unittest.TestCase):
    def test_redo_asks_for_every_media_again(self):
        root = Path(tempfile.mkdtemp())
        (root / 'wheel').mkdir()
        (root / 'wheel' / 'AAAA0000.png').write_bytes(b'x')
        index = {'AAAA0000': {'look': {'ground': '000000', 'band': None, 'sure': True, 'by': 'analysis'}}}
        self.assertEqual(harvest.todo_for('AAAA0000', ['wheel', 'look'], index, root, relook=False, redo=True), ['wheel', 'look'])


class Dats(unittest.TestCase):
    def test_a_hacks_dat_and_a_serial_dat_both_name_their_dumps(self):
        hacks = 'game (\n    name "Pokemon Prism [Hack by Koolboyman]"\n    rom ( name "a.gbc" crc 5ab2c1a8 )\n)\n'
        serial = ('game (\n\tcomment "Game Boy Advance Video - Shrek (USA)"\n\tserial "AGB-M2SE-USA"\n'
                  '\trom (\n\t\tcrc 0BB4D0A3\n\t)\n)\n'
                  'game (\n\tcomment "Metroid Fusion (USA)"\n\trom (\n\t\tcrc 6C8F4D3C\n\t)\n)\n')
        self.assertEqual(harvest.parse_dat(hacks), {'5AB2C1A8': 'Pokemon Prism [Hack by Koolboyman]'})
        self.assertEqual(harvest.parse_dat(serial, harvest.VIDEO), {'0BB4D0A3': 'Game Boy Advance Video - Shrek (USA)'})


class Extras(unittest.TestCase):
    def write(self, data):
        path = Path(tempfile.mkdtemp()) / 'extras.json'
        path.write_text(json.dumps(data))
        return path

    def test_slugs_are_ours_and_cannot_pass_for_a_checksum(self):
        for slug in ('Pokemon-Prism', '12345678', 'pokemon--prism', 'pokemon_prism', ''):
            with self.assertRaises(SystemExit):
                harvest.load_extras(self.write({'GBC': [{'slug': slug, 'name': 'x'}]}))
        good = {'GBC': [{'slug': 'pokemon-prism', 'name': 'Pokemon Prism'}]}
        self.assertEqual(harvest.load_extras(self.write(good)), good)

    def test_a_slug_is_listed_once(self):
        twice = {'GB': [{'slug': 'a-b', 'name': 'x'}], 'GBC': [{'slug': 'a-b', 'name': 'y'}]}
        with self.assertRaises(SystemExit):
            harvest.load_extras(self.write(twice))

    def test_a_search_hit_named_like_the_extra_beats_a_higher_ranked_one(self):
        data = {'response': {'jeux': [
            {},
            {'id': '2964', 'noms': [{'text': 'Super Mario Land 2 - 6 Golden Coins'}]},
            {'id': '142935', 'noms': [{'text': 'Super Mario Land DX'}]},
        ]}}
        self.assertEqual(harvest.best_hit(data, ['Super Mario Land DX'])['id'], '142935')
        self.assertEqual(harvest.best_hit(data, ['Pokémon - Super Mario'])['id'], '2964')
        dark = {'response': {'jeux': [{'id': '1', 'noms': [{'text': 'Pokémon - Dark Rising'}]}]}}
        self.assertEqual(harvest.best_hit(dark, ['Pokemon Dark Rising'])['id'], '1')
        self.assertIsNone(harvest.best_hit({'response': {'jeux': [{}]}}, ['x']))
        self.assertIsNone(harvest.best_hit(None, ['x']))

    def test_dumps_a_dat_gives_its_own_game_are_left_out(self):
        roms = [{'romcrc': 'aaaa0000'}, {'romcrc': 'BBBB1111'}, {'romcrc': ''}, {'romcrc': 'AAAA0000'}]
        self.assertEqual(harvest.new_crcs(roms, {'BBBB1111': 'Pokemon - Crystal Version (USA)'}), ['AAAA0000'])

    def test_an_entry_keeps_its_media_and_takes_its_names_from_the_list(self):
        old = {'name': 'Old', 'platform': 'GBC', 'crcs': ['X'], 'aka': ['gone'], 'wheel': 'GBC/wheel/a-b.png'}
        entry = harvest.extra_entry('GBC', {'slug': 'a-b', 'name': 'New'}, ['AAAA0000'], old)
        self.assertEqual(entry, {'wheel': 'GBC/wheel/a-b.png', 'name': 'New', 'platform': 'GBC', 'crcs': ['AAAA0000']})


if __name__ == '__main__':
    unittest.main()
