"""Before/after offline CPU timings of actual HA input and render scripts.

No network or HA client exists in this program. All outgoing services are
captured by the simulator. Results measure script/template CPU on this host;
they cannot estimate remote-radio, HA event scheduling, or bulb latency.
"""
import argparse
from collections import Counter
import gc
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time

STAGE = Path(__file__).resolve().parent
sys.path.insert(0, str(STAGE / 'tests'))
from input_harness import InputSim, ROOM  # noqa: E402


def stats(samples):
    ordered = sorted(samples)
    return {'n': len(samples), 'median_ms': round(statistics.median(samples) * 1000, 3),
            'p95_ms': round(ordered[min(len(ordered) - 1, int(len(ordered) * .95))] * 1000, 3),
            'max_ms': round(max(samples) * 1000, 3)}


def measure(call):
    cpu = time.process_time()
    wall = time.perf_counter()
    call()
    return time.perf_counter() - wall, time.process_time() - cpu


def signature(path):
    h = hashlib.sha256()
    for file in sorted(path.glob('*.json')):
        h.update(file.name.encode())
        h.update(file.read_bytes())
    return h.hexdigest()


def counts(sim):
    return {'scripts': dict(Counter(sim.script_runs)),
            'service_calls': len(sim.calls),
            'captured_zigbee_messages': len(sim.sends()),
            'blocking_steps': len(sim.blocking_steps)}


def prepare(candidate, candle, expiry=False):
    sim = InputSim(candidate=candidate, candle=candle, expiry=expiry)
    sim.seed()
    # Exercise/cache every template on the measured path, including the initial
    # room-cache miss. The benchmark reports steady state separately from cold.
    first_wall, first_cpu = measure(lambda: sim.click('down'))
    first = {'wall_ms': round(first_wall * 1000, 3), 'cpu_ms': round(first_cpu * 1000, 3),
             'input_work': counts(sim)}
    sim.clear_observations()
    render_wall, render_cpu = measure(sim.drain)
    first['render'] = {'wall_ms': round(render_wall * 1000, 3),
                       'cpu_ms': round(render_cpu * 1000, 3), 'work': counts(sim)}
    for command in ['up', 'down']:
        sim.click(command)
        sim.drain()
    sim.clear_observations()
    return sim, first


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, default=STAGE.parent / 'simple-effects/candidate')
    parser.add_argument('--candidate', type=Path, default=STAGE / 'candidate')
    parser.add_argument('--samples', type=int, default=40)
    parser.add_argument('--expiry', action='store_true',
                        help='Enable production next-schedule-block override expiry')
    parser.add_argument('--output', type=Path, default=STAGE / 'benchmark-results.json')
    args = parser.parse_args()
    assert args.samples >= 10
    result = {'measurement': 'Offline actual-script CPU; not physical press-to-bulb latency',
              'expiry_enabled': args.expiry,
              'versions': {label: {'path': str(path), 'sha256': signature(path)}
                           for label, path in [('baseline', args.baseline), ('candidate', args.candidate)]},
              'scenarios': {}}
    for candle in [False, True]:
        name = 'normal_room' if not candle else 'one_configured_candle'
        prepared = {label: prepare(path, candle, expiry=args.expiry)
                    for label, path in [('baseline', args.baseline), ('candidate', args.candidate)]}
        scenario = {label: {'first_input_after_house_seed': first} for label, (_, first) in prepared.items()}
        samples = {label: {'wall': [], 'cpu': []} for label in prepared}
        gc.collect()
        # Interleave versions each sample to reduce warm-host/order bias.
        for index in range(args.samples):
            order = ['baseline', 'candidate'] if index % 2 == 0 else ['candidate', 'baseline']
            for label in order:
                sim = prepared[label][0]
                wall, cpu = measure(lambda: sim.click('up' if index % 2 == 0 else 'down'))
                samples[label]['wall'].append(wall)
                samples[label]['cpu'].append(cpu)
        for label, (sim, _) in prepared.items():
            scenario[label]['warm_input_burst'] = {'wall': stats(samples[label]['wall']),
                                                    'cpu': stats(samples[label]['cpu']), 'work': counts(sim)}
            sim.clear_observations()
            wall, cpu = measure(lambda: sim.drain(limit=args.samples + 10))
            scenario[label]['coalesced_burst_drain'] = {'wall_ms': round(wall * 1000, 3),
                                                       'cpu_ms': round(cpu * 1000, 3), 'work': counts(sim)}
            sim.clear_observations()
        interactive = {label: {'input_wall': [], 'input_cpu': [], 'render_wall': [], 'render_cpu': []}
                       for label in prepared}
        for index in range(args.samples):
            order = ['candidate', 'baseline'] if index % 2 == 0 else ['baseline', 'candidate']
            for label in order:
                sim = prepared[label][0]
                wall, cpu = measure(lambda: sim.click('up' if index % 2 == 0 else 'down'))
                interactive[label]['input_wall'].append(wall)
                interactive[label]['input_cpu'].append(cpu)
                wall, cpu = measure(sim.drain)
                interactive[label]['render_wall'].append(wall)
                interactive[label]['render_cpu'].append(cpu)
        for label, (sim, _) in prepared.items():
            scenario[label]['interactive'] = {key: stats(value) for key, value in interactive[label].items()}
            scenario[label]['interactive']['work'] = counts(sim)
            assert not sim.pending_rooms()
            assert not sim.blocking_steps
        result['scenarios'][name] = scenario
    for label, version in result['versions'].items():
        assert signature(Path(version['path'])) == version['sha256'], \
            f'{label} artifacts changed during measurement; rerun after the build settles'
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
