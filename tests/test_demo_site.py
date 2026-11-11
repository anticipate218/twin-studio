import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from build_demo_site import build


class SiteTests(unittest.TestCase):
    def test_static_site_has_only_synthetic_assets_and_project_relative_modules(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'site'; result=build(out)
            self.assertGreater(result['gaussians'],10000)
            html=(out/'app/index.html').read_text(encoding='utf-8')
            self.assertIn('../demo/api.js',html)
            self.assertIn('../vendor/three/three.module.js',html)
            self.assertNotIn('src="/static/',html)
            data=json.loads((out/'demo/demo.json').read_text(encoding='utf-8'))
            self.assertTrue(data['buildings']['synthetic'])
            self.assertEqual(len(data['materials']),3)
            self.assertTrue(json.loads((out/'demo/evidence/0').read_text(encoding='utf-8'))['synthetic'])
            self.assertFalse(any(p.name=='config.local.json' for p in out.rglob('*')))
            self.assertIn('<video ',(out/'index.html').read_text(encoding='utf-8'))
            self.assertEqual(result['gaussians'],build(out)['gaussians'])

    def test_refuses_to_replace_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'unrelated';out.mkdir();(out/'keep.txt').write_text('keep')
            with self.assertRaises(ValueError):build(out)
            self.assertEqual((out/'keep.txt').read_text(),'keep')


if __name__=='__main__':unittest.main()
