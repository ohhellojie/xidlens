import json
from pathlib import Path
import tempfile
import unittest
from test_catalog import catalog, rule

class BuiltinKnowledgeTests(unittest.TestCase):
    def test_search_catalog_matches_parser_default(self):
        root=Path(__file__).resolve().parents[1]
        library=json.loads((root/'frontend/src/catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(library['cn']['codes'],catalog.DEFAULT['codes'])
        self.assertEqual(set(library['cn']['codes']),set(library['en']['codes']))
        self.assertEqual(len(library['cn']['codes']),172)
        self.assertNotIn('audit',library)

    def test_empty_legacy_rules_upgrade_without_overwriting_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'rules/active.json';path.parent.mkdir()
            old=json.dumps({'catalog':{'file':'official-reference-links','sha256':'','codes':{}},'importedAt':''})
            path.write_text(old,encoding='utf-8')
            store=catalog.CatalogStore(folder)
            self.assertEqual(store.snapshot()['codes'],catalog.DEFAULT['codes'])
            self.assertEqual(path.read_text(encoding='utf-8'),old)

    def test_custom_rules_survive_upgrade_and_reset_restores_chinese(self):
        with tempfile.TemporaryDirectory() as folder:
            store=catalog.CatalogStore(folder)
            store.import_file(json.dumps(rule('Custom')).encode(),'custom.json')
            loaded=catalog.CatalogStore(folder)
            self.assertEqual(loaded.snapshot()['codes']['79']['title'],'Custom')
            loaded.reset()
            self.assertEqual(catalog.CatalogStore(folder).snapshot()['codes'],catalog.DEFAULT['codes'])
