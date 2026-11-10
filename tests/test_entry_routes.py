"""The retired entry points always lead to the one supported workspace."""
import http.client
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Handler, ThreadingHTTPServer


class EntryRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_retired_bookmarks_redirect(self):
        for path in ('/lite', '/lite/', '/static/lite/', '/static/lite/index.html'):
            with self.subTest(path=path):
                con = http.client.HTTPConnection(*self.server.server_address, timeout=5)
                con.request('GET', path)
                response = con.getresponse()
                body = response.read()
                con.close()
                self.assertEqual(response.status, 302)
                self.assertEqual(response.getheader('Location'), '/')
                self.assertEqual(body, b'')

    def test_main_entry_is_the_complete_workspace(self):
        con = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        con.request('GET', '/')
        response = con.getresponse()
        self.assertEqual(response.status, 200)
        html = response.read().decode('utf-8')
        for page in ('scene', 'material', 'modeling', 'system'):
            self.assertIn('id="view-' + page + '"', html)
        self.assertNotIn('chip-lite', html)
        self.assertNotIn('edition-badge', html)
        con.close()


if __name__ == '__main__':
    unittest.main()
