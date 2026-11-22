"""The environment both e2e backends load through.

Each case runs in its own interpreter: `open_sim` allows one backend per
process, so a shared test process could not open both.
"""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest

from tests.e2e.env import reference_available

ROOT = Path(__file__).resolve().parents[2]


def isolated(body: str, prelude: str = '') -> dict:
    """Run `body` in a fresh interpreter; it must print one JSON object last."""
    source = textwrap.dedent(prelude) + textwrap.dedent(body)
    completed = subprocess.run([sys.executable, '-c', source], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
    assert completed.returncode == 0, completed.stderr[-4000:]
    return json.loads(completed.stdout.strip().splitlines()[-1])


CHILDREN = '''
        def children():
            import os
            pid = os.getpid()
            return [int(child) for task in os.listdir(f'/proc/{pid}/task')
                    for child in open(f'/proc/{pid}/task/{task}/children').read().split()]
'''


@unittest.skipUnless(reference_available(), 'private reference or HA wrapper missing')
class OpenSimTests(unittest.TestCase):
    def test_reference_loads_the_captured_live_automations(self):
        result = isolated('''
            import json
            from tests.e2e.env import ROOT, open_sim
            with open_sim('reference') as sim:
                captured = json.loads((ROOT / 'reference/live/automations/lighting_schedule_engine.json').read_text())
                print(json.dumps({'engine': sim.automations.get('automation_lighting_schedule_engine')
                                  == captured.get('config', captured)}))
        ''')
        self.assertTrue(result['engine'])

    def test_reference_runs_the_jinja_interpreter(self):
        result = isolated('''
            import json
            from tests.e2e.env import open_sim
            with open_sim('reference') as sim:
                context = {}
                sim.seq([{'variables': {'x': '{{ 1 + 1 }}'}}], context)
                print(json.dumps({'x': context['x']}))
        ''')
        self.assertEqual(result['x'], 2)

    def test_port_refuses_the_jinja_interpreter(self):
        result = isolated('''
            import json
            from tests.e2e.env import open_sim
            with open_sim('port') as sim:
                try:
                    sim.seq([{'variables': {'x': '{{ 1 + 1 }}'}}], {})
                    refused = False
                except AssertionError as error:
                    refused = 'Unsupported parity seam' in str(error)
                print(json.dumps({'refused': refused}))
        ''')
        self.assertTrue(result['refused'])

    def test_both_backends_expose_the_unpatched_renderer(self):
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                result = isolated(f'''
                    import json
                    from tests.e2e.env import open_sim
                    with open_sim({backend!r}) as sim:
                        print(json.dumps({{'x': sim.e2e_render('{{{{ value | int + 1 }}}}', {{'value': '41'}})}}))
                ''')
                self.assertEqual(result['x'], 42)

    def test_port_closes_node_and_stage_on_exit(self):
        result = isolated(prelude=CHILDREN, body='''
            import json, os
            from pathlib import Path
            from tests.e2e.env import open_sim
            with open_sim('port') as sim:
                candidate = Path(os.environ['LIGHTING_CANDIDATE'])
                inside = {'children': len(children()), 'stage': candidate.is_dir()}
            print(json.dumps({'inside': inside, 'children': len(children()), 'stage': candidate.exists()}))
        ''')
        self.assertEqual(result['inside'], {'children': 1, 'stage': True})
        self.assertEqual((result['children'], result['stage']), (0, False))

    def test_reopening_a_backend_loads_the_new_stage(self):
        result = isolated('''
            import json
            from tests.e2e.env import open_sim
            counts = []
            for _ in range(2):
                with open_sim('reference') as sim:
                    counts.append(len(sim.automations))
            print(json.dumps({'counts': counts}))
        ''')
        self.assertGreater(result['counts'][0], 0)
        self.assertEqual(result['counts'][0], result['counts'][1])

    def test_mixing_backends_in_one_process_raises(self):
        result = isolated('''
            import json
            from tests.e2e.env import BackendMixed, open_sim
            with open_sim('reference'):
                pass
            try:
                with open_sim('port'):
                    pass
                raised = False
            except BackendMixed:
                raised = True
            print(json.dumps({'raised': raised}))
        ''')
        self.assertTrue(result['raised'])


if __name__ == '__main__':
    unittest.main()
