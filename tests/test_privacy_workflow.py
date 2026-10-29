"""Exercise full-history privacy coverage with a synthetic PR merge ref."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('workflow_privacy_guard', ROOT / 'tools/privacy_guard.py')
privacy_guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy_guard)


class PrivacyWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.remote.mkdir()
        self.git(self.remote, 'init', '--bare')
        self.tree = self.git(self.remote, 'mktree', stdin='')
        self.base = self.commit('base')
        self.head = self.commit('head', self.base)
        self.tag_only = self.commit('tag-only', self.base)
        self.merge = self.commit('synthetic merge', self.base, self.head, author='UnapprovedFixture')
        for name, commit in [('refs/heads/main', self.base), ('refs/heads/feature', self.head),
                             ('refs/tags/vfixture', self.tag_only), ('refs/pull/1/merge', self.merge)]:
            self.git(self.remote, 'update-ref', name, commit)

    def git(self, root, *args, stdin=None, author='PublicAuthor'):
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
                   GIT_AUTHOR_NAME=author, GIT_AUTHOR_EMAIL='fixture@example.test',
                   GIT_COMMITTER_NAME=author, GIT_COMMITTER_EMAIL='fixture@example.test')
        return subprocess.run(['git', '-C', str(root), *args], input=stdin, text=True,
                              capture_output=True, check=True, env=env).stdout.strip()

    def commit(self, message, *parents, author='PublicAuthor'):
        args = ['commit-tree', self.tree, '-m', message]
        for parent in parents:
            args.extend(['-p', parent])
        return self.git(self.remote, *args, author=author)

    def checkout(self, name, commit=None, merge_ref=False):
        checkout = self.root / name
        checkout.mkdir()
        self.git(checkout, 'init')
        self.git(checkout, 'remote', 'add', 'origin', str(self.remote))
        # actions/checkout@v4: getRefSpecForAllHistory('', exact_sha).
        specs = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']
        if merge_ref:
            specs.append(f'+{self.merge}:refs/remotes/pull/1/merge')
        self.git(checkout, 'fetch', '--prune', '--no-recurse-submodules', 'origin', *specs)
        target = self.merge if merge_ref else commit or self.head
        exists = subprocess.run(['git', '-C', str(checkout), 'cat-file', '-e', target], capture_output=True)
        if exists.returncode:
            # A fork head or a moved branch is fetched by SHA, without a pull ref.
            self.git(checkout, 'fetch', 'origin', target)
        self.git(checkout, 'checkout', '--detach', target)
        (checkout / '.privacy-policy.json').write_text(json.dumps({
            'public_git_names': ['PublicAuthor'], 'private_files': [], 'reviewed_images': {},
        }), encoding='utf-8')
        return checkout

    def check_history(self, checkout):
        guard = privacy_guard.Guard(checkout)
        guard.history()
        return guard.errors

    def test_workflow_pins_exact_head_and_retains_full_history(self):
        workflow = (ROOT / '.github/workflows/privacy.yml').read_text(encoding='utf-8')
        self.assertRegex(workflow, r'ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}')
        self.assertRegex(workflow, r'fetch-depth:\s*0')
        self.assertIn('python tools/privacy_guard.py --history', workflow)
        checks = (ROOT / '.github/workflows/checks.yml').read_text(encoding='utf-8')
        first_checkout = re.search(r'- uses: actions/checkout@v4(?P<options>.*?)(?=\n\s*- )', checks, re.S)
        self.assertIsNotNone(first_checkout)
        self.assertNotRegex(first_checkout['options'], r'\bref:', 'Checks must retain its default merge checkout')

    def test_exact_head_excludes_only_unreferenced_synthetic_merge(self):
        old = self.checkout('old', merge_ref=True)
        self.assertTrue(any('approved public name' in error for error in self.check_history(old)))
        new = self.checkout('new')
        self.assertEqual(self.git(new, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(self.git(new, 'for-each-ref', 'refs/remotes/pull', '--format=%(refname)'), '')
        commits = set(self.git(new, 'rev-list', '--all').splitlines())
        self.assertEqual(commits, {self.base, self.head, self.tag_only})
        self.assertEqual(self.check_history(new), set())

    def test_unapproved_real_branch_history_still_fails(self):
        private_commit = self.commit('real branch', self.base, author='UnapprovedFixture')
        self.git(self.remote, 'update-ref', 'refs/heads/other', private_commit)
        checkout = self.checkout('branch')
        self.assertIn(private_commit, self.git(checkout, 'rev-list', '--all').splitlines())
        self.assertTrue(any('approved public name' in error for error in self.check_history(checkout)))

    def test_unapproved_real_tag_history_and_tagger_still_fail(self):
        private_commit = self.commit('tag history', self.base, author='UnapprovedFixture')
        self.git(self.remote, 'tag', '-a', 'review-fixture', private_commit, '-m', 'fixture', author='UnapprovedFixture')
        checkout = self.checkout('tag')
        self.assertIn(private_commit, self.git(checkout, 'rev-list', '--all').splitlines())
        errors = self.check_history(checkout)
        self.assertIn('Git commit author: Git identity needs an approved public name', errors)
        self.assertIn('Git tag author: Git identity needs an approved public name', errors)

    def test_unapproved_detached_pr_head_still_fails(self):
        fork_head = self.commit('fork head', self.base, author='UnapprovedFixture')
        self.git(self.remote, 'update-ref', 'refs/pull/2/head', fork_head)
        checkout = self.checkout('fork', commit=fork_head)
        self.assertIn(fork_head, self.git(checkout, 'rev-list', '--all').splitlines())
        self.assertEqual(self.git(checkout, 'for-each-ref', 'refs/remotes/pull', '--format=%(refname)'), '')
        self.assertTrue(any('approved public name' in error for error in self.check_history(checkout)))


if __name__ == '__main__':
    unittest.main()
