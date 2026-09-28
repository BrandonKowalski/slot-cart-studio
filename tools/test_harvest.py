"""The label cropped out of a ScreenScraper cart scan. Run from tools/: python3 -m unittest test_harvest"""

import io
import unittest

from PIL import Image

import harvest


def png(im):
    out = io.BytesIO()
    im.save(out, 'PNG')
    return out.getvalue()


def decoded(data):
    return Image.open(io.BytesIO(data))


class CropLabel(unittest.TestCase):
    def template(self, size, box):
        """A template scan whose label fills `box`, with a pixel of plastic left around it."""
        im = Image.new('RGBA', size, (150, 150, 150, 255))
        im.paste((200, 30, 30, 255), (box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1))
        return decoded(harvest.crop_label(png(im)))

    def test_a_game_boy_template_crops_to_its_label(self):
        label = self.template((600, 678), (91, 209, 504, 572))
        self.assertEqual(label.size, (413, 363))
        self.assertEqual(label.mode, 'RGB')
        self.assertEqual(set(label.getdata()), {(200, 30, 30)})

    def test_a_gba_template_crops_to_its_label(self):
        label = self.template((600, 355), (88, 86, 515, 302))
        self.assertEqual(label.size, (427, 216))
        self.assertEqual(set(label.getdata()), {(200, 30, 30)})

    def test_a_game_boy_color_template_crops_to_its_label(self):
        label = self.template((600, 701), (97, 254, 519, 631))
        self.assertEqual(label.size, (422, 377))
        self.assertEqual(set(label.getdata()), {(200, 30, 30)})

    def test_a_photograph_is_cropped_by_the_carts_own_outline(self):
        # A cart 480 by 532 inside a clear margin, its label where the Game Boy template puts it.
        im = Image.new('RGBA', (560, 612), (0, 0, 0, 0))
        im.paste((150, 150, 150, 255), (40, 40, 520, 572))
        l, t = 40 + round(91 / 600 * 480), 40 + round(209 / 665 * 532)
        r, b = 40 + round(504 / 600 * 480), 40 + round(572 / 665 * 532)
        im.paste((30, 30, 200, 255), (l, t, r, b))
        label = decoded(harvest.crop_label(png(im)))
        self.assertAlmostEqual(label.size[0], r - l, delta=2)
        self.assertAlmostEqual(label.size[1], b - t, delta=2)
        blue = sum(1 for p in label.getdata() if p == (30, 30, 200))
        self.assertGreater(blue / (label.size[0] * label.size[1]), 0.97)

    def test_a_scan_it_cannot_place_is_skipped(self):
        self.assertIsNone(harvest.crop_label(png(Image.new('RGB', (300, 300), (150, 150, 150)))))
        self.assertIsNone(harvest.crop_label(b'not a png'))


if __name__ == '__main__':
    unittest.main()
