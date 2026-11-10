import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from create_demo import create_demo, RECORD


class DemoTests(unittest.TestCase):
    def test_synthetic_geometry_and_format(self):
        with tempfile.TemporaryDirectory() as folder:
            result = create_demo(folder)
            binary = Path(result['path']).read_bytes()
            self.assertEqual(len(binary) % 32, 0)
            self.assertGreater(result['gaussians'], 10000)
            self.assertEqual(result['buildings'], 12)
            self.assertEqual(RECORD.unpack_from(binary)[6], 83)
            meta = json.loads(Path(folder, 'models/demo_city.buildings.json').read_text(encoding='utf-8'))
            self.assertTrue(meta['synthetic'])
            self.assertTrue(all(b['top'] > b['base'] for b in meta['buildings']))
            self.assertTrue(Path(folder, 'previews/demo_city.png').read_bytes().startswith(b'\x89PNG'))

    def test_repeat_does_not_overwrite_existing_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            result = create_demo(folder)
            original = Path(result['path']).read_bytes()
            with self.assertRaises(FileExistsError): create_demo(folder)
            self.assertEqual(Path(result['path']).read_bytes(), original)

    def test_demo_is_reproducible(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            left, right = create_demo(a), create_demo(b)
            self.assertEqual(Path(left['path']).read_bytes(), Path(right['path']).read_bytes())


if __name__ == '__main__': unittest.main()
