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

    def test_both_backends_nudge_a_commit_by_a_millisecond(self):
        # Ruling 53: the simulators' 1 µs nudge before each ls_commit is below the port's millisecond clock.
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                result = isolated(f'''
                    import json
                    from tests.e2e.env import COMMIT_NUDGE, open_sim
                    with open_sim({backend!r}) as sim:
                        steps = []
                        for seconds in (.000001, 2.5, 60):
                            before = sim.elapsed
                            sim.advance(seconds)
                            steps.append(sim.elapsed - before)
                        print(json.dumps({{'steps': steps, 'nudge': COMMIT_NUDGE}}))
                ''')
                self.assertEqual(result['nudge'], 0.001)
                for step, expected in zip(result['steps'], (0.001, 2.5, 60)):
                    self.assertAlmostEqual(step, expected, places=9)

    def test_a_stored_profile_gives_its_template_light_the_colour_ha_derives(self):
        # Ruling 54, as live HA reports a template light: 2197 K is rgb [255, 146, 39], hs from the kelvin;
        # an hs light has no kelvin.
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                result = isolated(f'''
                    import json
                    from tests.e2e.env import open_sim
                    with open_sim({backend!r}) as sim:
                        lights = {{}}
                        for block, profile in (('day', {{'on': True, 'b': 100, 'm': 'ct', 'k': 2197}}),
                                               ('night', {{'on': True, 'b': 20, 'm': 'hs', 'h': 20.0, 's': 80.0}})):
                            sim.store(f'input_text.ls_house_{{block}}', profile)
                            lights[block] = sim.state[f'light.ls_house_{{block}}']
                        print(json.dumps(lights))
                ''')
                day, night = result['day']['attributes'], result['night']['attributes']
                self.assertEqual((day['brightness'], day['color_mode'], day['color_temp_kelvin'], day['rgb_color']),
                                 (100, 'color_temp', 2197, [255, 146, 39]))
                self.assertEqual(day['hs_color'], [29.808, 84.78])
                self.assertEqual((night['color_mode'], night['color_temp_kelvin'], night['hs_color']),
                                 ('hs', None, [20.0, 80.0]))
                self.assertEqual(night['rgb_color'], [255, 119, 51])

    def test_a_profile_a_script_saves_reaches_its_template_light_on_both_backends(self):
        # Finding 5: the reference's own store mirrors a saved profile; the port's simulator writes the text only.
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                result = isolated(f'''
                    import json
                    from tests.e2e.env import open_sim
                    with open_sim({backend!r}) as sim:
                        sim.run('ls_store', store='input_text.ls_house_day', kelvin=4651)
                        print(json.dumps(sim.state['light.ls_house_day']['attributes']))
                ''')
                self.assertEqual((result['color_temp_kelvin'], result['rgb_color']), (4651, [255, 221, 193]))

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
