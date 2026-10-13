import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from window_layout import fitted_bounds


class WindowLayoutTests(unittest.TestCase):
    def test_fits_and_centers_in_usable_area(self):
        # Small displays, taskbars on either edge, and negative monitor origins.
        for area in [(0, 0, 1366, 728), (0, 48, 1920, 1032),
                     (-1920, 0, 1920, 1040), (1920, -160, 2560, 1392),
                     (60, 0, 964, 600)]:
            for scale in (1, 1.25, 1.5, 2):
                with self.subTest(area=area, scale=scale):
                    left, top, aw, ah = area
                    x, y, w, h, min_w, min_h = fitted_bounds(area, scale)
                    self.assertGreater(x, left)
                    self.assertGreater(y, top)
                    self.assertLess(x + w, left + aw)
                    self.assertLess(y + h, top + ah)
                    self.assertLessEqual(abs((x - left) - (left + aw - x - w)), 1)
                    self.assertLessEqual(abs((y - top) - (top + ah - y - h)), 1)
                    self.assertLessEqual(min_w, w)
                    self.assertLessEqual(min_h, h)


if __name__ == '__main__':
    unittest.main()
