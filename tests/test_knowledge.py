import json
from pathlib import Path
import tempfile
import unittest
from test_catalog import catalog, rule
import knowledge

class BuiltinKnowledgeTests(unittest.TestCase):
    def test_search_catalog_matches_parser_default(self):
        root=Path(__file__).resolve().parents[1]
        library=json.loads((root/'app/knowledge/xid.json').read_text(encoding='utf-8'))['content']
        self.assertEqual(library['cn']['codes'],catalog.DEFAULT['codes'])
        self.assertEqual(set(library['cn']['codes']),set(library['en']['codes']))
        self.assertEqual(len(library['cn']['codes']),172)
        self.assertNotIn('audit',library)

    def test_builtin_manual_validates_and_cross_references_xid_catalog(self):
        root=Path(__file__).resolve().parents[1]
        codes=set(json.loads((root/'app/knowledge/xid.json').read_text(encoding='utf-8'))['content']['cn']['codes'])
        manual=knowledge.checked((root/'app/knowledge/manual.json').read_bytes(),'manual')['content']
        ids=[t['id'] for t in manual['topics']]
        self.assertEqual(ids,[t['id'] for t in manual['en']])
        for required in ('overview','start','triage','collect','triage-xid','reset','diag','network','13','health','xid-intro','xid-working','xid-catalog','48','mem-rma'):
            self.assertIn(required,ids)
        for lang_topics in (manual['topics'],manual['en']):
            for topic in lang_topics:
                self.assertTrue(set(topic['related'])<=codes,topic['id'])
                self.assertTrue(set(topic.get('extracts',[]))<=codes,topic['id'])
                for branch in topic.get('branches',[]):
                    self.assertIn(branch['code'],codes,topic['id'])
            triage=next(t for t in lang_topics if t['id']=='triage')
            self.assertEqual([f['id'] for f in triage.get('figures',[])],['triage-fig1','triage-fig2','triage-fig3'])
            self.assertEqual([f['step'] for f in triage.get('figures',[])],[0,1,2])

    def test_manual_figures_validation_rejects_invalid_entries(self):
        root=Path(__file__).resolve().parents[1]
        base=json.loads((root/'app/knowledge/manual.json').read_text(encoding='utf-8'))
        for bad_figures in ([], [{'id':'bad id!','step':0,'caption':'x'}], [{'id':'ok','step':99,'caption':'x'}], [{'id':'ok','step':True,'caption':'x'}]):
            pack=json.loads(json.dumps(base))
            pack['content']['topics'][2]['figures']=bad_figures
            with self.assertRaises(ValueError):
                knowledge.checked(json.dumps(pack).encode('utf-8'),'manual')

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
