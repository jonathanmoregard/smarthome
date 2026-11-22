"""Golden scenarios: recorded from the reference, replayed on the port.

The unguarded cases use a synthetic house (`room_a`, `light.lamp_a1`) and a
temporary golden directory. The guarded cases replay every scenario on the real
port against its private recording; they read every catalog name at run time
and never write one into this file. Differences between the backends are
expected while M0 measures (ruling 2) and stay failing, listed in
`.runtime/e2e/golden/<name>.differences.json`.
"""
from __future__ import annotations
from dataclasses import replace
from datetime import datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from tests.e2e import env
from tests.e2e.codec import (Advance, Checkpoint, HelperInfo, HouseInfo, LampInfo, PersonLightChange, PowerCut,
                             PowerRestore, PressSwitch, RemoteInfo, Seed)
from tests.e2e.backend import SOFTWARE_CANDLE
from tests.e2e.compare import compare
from tests.e2e.golden import (GOLDEN, MissingRecording, StaleRecording, differ, load, replay, save, sources_hash,
                              write_differences)
from tests.e2e.router import LOCAL, HaStart, Mqtt, ScriptCall, StateChanged
from tests.e2e.runner import BackendRun
from tests.e2e.scenarios import (AFTER_MINUTES, AFTER_RULE, NAMES, NEXT_BLOCK_RULE, OVERLAY_MINUTES, MissingRole, Proof,
                                 Scenario, scenarios, seeds_for)
from tests.e2e.world import Kelvin, Off, On

BLOCKS = ('day', 'cosy', 'night')
DATETIME = {'has_date': False, 'has_time': True, 'editable': True}
FADE = {'min': 0, 'max': 120, 'step': 1, 'mode': 'box'}
TEXT = {'max': 255}
UNUSED = {'Breathe', 'Colour loop'}


def helper(entity, room, lamp, block, setting):
    state, attributes = {'light': ('{"on": true, "b": 150}', TEXT), 'start': ('07:00:00', DATETIME),
                         'weekend': ('07:00:00', DATETIME), 'fade': ('20', FADE),
                         'own_light': ('off', {}), 'own_timing': ('off', {})}[setting]
    return HelperInfo(entity, room, lamp, block, setting, state, dict(attributes))


OVERLAY_RULE_SEEDS = (Seed('input_boolean.ls_ovr_after_on', 'on', {'icon': 'after'}),
                      Seed('input_boolean.ls_ovr_next_block_on', 'on', {'icon': 'next'}),
                      Seed('input_number.ls_ovr_after_min', '180.0', {'min': 15, 'max': 720, 'step': 15}))


def synthetic_house(candle_lamp_has_store=True) -> HouseInfo:
    lamps = (LampInfo('light.lamp_a1', 'room_a', ('bulb_a1',), False),
             LampInfo('light.lamp_b1', 'room_b', ('bulb_b1', 'bulb_b2'), True),
             LampInfo('light.lamp_b2', 'room_b', ('bulb_b3',), False))
    helpers = []
    for block in BLOCKS:
        helpers += [helper(f'input_text.ls_house_{block}', None, None, block, 'light'),
                    helper(f'input_datetime.ls_house_{block}_start', None, None, block, 'start'),
                    helper(f'input_datetime.ls_house_{block}_weekend', None, None, block, 'weekend'),
                    helper(f'input_number.ls_house_{block}_fade', None, None, block, 'fade')]
        helpers += [helper(f'{domain}.ls_room_b_{block}{suffix}', 'room_b', None, block, setting)
                    for domain, suffix, setting in (
                        ('input_text', '', 'light'), ('input_datetime', '_start', 'start'),
                        ('input_datetime', '_weekend', 'weekend'), ('input_number', '_fade', 'fade'),
                        ('input_boolean', '_own_light', 'own_light'), ('input_boolean', '_own_timing', 'own_timing'))]
        for lamp in lamps:
            if lamp.candle_capable and not candle_lamp_has_store:
                continue
            name = lamp.lamp.removeprefix('light.')
            helpers.append(helper(f'input_text.ls_lamp_{name}_{block}', lamp.room, lamp.lamp, block, 'light'))
    return HouseInfo(rooms=('room_a', 'room_b'), lamps=lamps,
                     remotes=(RemoteInfo(None, 'zigbee2mqtt/remote_x/action', ('on', 'off')),
                              RemoteInfo('room_b', 'zigbee2mqtt/remote_y/action',
                                         ('on', 'off', 'brightness_step_up', 'brightness_step_down'))),
                     plugs=('switch.e2e_plug_0', 'switch.e2e_plug_1'), helpers=tuple(sorted(helpers, key=lambda h: h.entity)),
                     dashboard_options={'ls_override_block.block': BLOCKS}, mode_switch='input_boolean.mode_x',
                     candle_lamps=('light.lamp_a1', 'light.lamp_b1'), overlay_rules=OVERLAY_RULE_SEEDS)


def steps_of(scenario, kind):
    return [(index, step) for index, step in enumerate(scenario.steps) if isinstance(step, kind)]


def local_at(scenario, index):
    """The local time the scenario's clock reads after step `index`."""
    seconds = sum(step.seconds for step in scenario.steps[:index + 1] if isinstance(step, Advance))
    return (scenario.start + timedelta(seconds=seconds)).astimezone(LOCAL)


def profiles(scenario):
    return {seed.entity: json.loads(seed.state) for seed in scenario.seeds if seed.entity.startswith('input_text.')}


# --- seeds -----------------------------------------------------------------------------------------------

class Seeds(unittest.TestCase):
    house = synthetic_house()

    def test_seeds_are_reproducible(self):
        self.assertEqual(seeds_for(self.house, 7), seeds_for(self.house, 7))
        self.assertNotEqual(seeds_for(self.house, 7), seeds_for(self.house, 8))

    def test_seeds_change_only_the_state_of_existing_helpers(self):
        by_entity = {helper.entity: helper for helper in self.house.helpers}
        seeds = seeds_for(self.house, 7)
        self.assertEqual([seed.entity for seed in seeds], sorted(by_entity))
        for seed in seeds:
            self.assertEqual(dict(seed.attributes), dict(by_entity[seed.entity].attributes))

    def test_values_are_distinct_per_scope_and_block(self):
        # Ruling 9: every room and lamp gets its own light and timing, so the comparison sees each one.
        seeds = {seed.entity: seed.state for seed in seeds_for(self.house, 7)}
        for setting in ('light', 'start', 'weekend', 'fade'):
            for block in BLOCKS:
                with self.subTest(setting=setting, block=block):
                    values = [seeds[h.entity] for h in self.house.helpers if (h.setting, h.block) == (setting, block)]
                    self.assertEqual(len(values), len(set(values)))
        lights = [seeds[h.entity] for h in self.house.helpers if h.setting == 'light']
        self.assertEqual(len(lights), len(set(lights)))

    def test_weekday_and_weekend_starts_differ(self):
        seeds = {seed.entity: seed.state for seed in seeds_for(self.house, 7)}
        for start in (h for h in self.house.helpers if h.setting == 'start'):
            weekend = next(h for h in self.house.helpers if h.setting == 'weekend'
                           and (h.room, h.lamp, h.block) == (start.room, start.lamp, start.block))
            self.assertNotEqual(seeds[start.entity], seeds[weekend.entity])

    def test_a_fade_helper_without_bounds_is_refused(self):
        unbounded = replace(next(h for h in self.house.helpers if h.setting == 'fade'), attributes={})
        with self.assertRaises(KeyError):
            seeds_for(replace(self.house, helpers=(unbounded,)), 7)

    def test_values_are_valid_for_their_helper(self):
        for seed in seeds_for(self.house, 7):
            info = next(h for h in self.house.helpers if h.entity == seed.entity)
            with self.subTest(setting=info.setting):
                if info.setting in ('start', 'weekend'):
                    hour, minute, second = (int(part) for part in seed.state.split(':'))
                    self.assertTrue(0 <= hour < 24 and 0 <= minute < 60 and second == 0)
                elif info.setting == 'fade':
                    self.assertTrue(FADE['min'] <= float(seed.state) <= FADE['max'])
                elif info.setting in ('own_light', 'own_timing'):
                    self.assertEqual(seed.state, 'on')   # the room's own values are the ones it shows
                else:
                    profile = json.loads(seed.state)
                    self.assertLessEqual(len(seed.state), TEXT['max'])
                    self.assertEqual(profile['effect'], 'Normal light')
                    self.assertTrue(1 <= profile['b'] <= 255)
                    self.assertEqual('own' in profile, info.lamp is not None)


# --- scenarios -------------------------------------------------------------------------------------------

class Scenarios(unittest.TestCase):
    house = synthetic_house()

    @classmethod
    def setUpClass(cls):
        built = scenarios(cls.house)
        cls.all = {name: built[name] for name in built.names}

    def test_the_named_scenarios(self):
        self.assertEqual(tuple(self.all), NAMES)
        for name, scenario in self.all.items():
            self.assertEqual(scenario.name, name)
            self.assertIsInstance(scenario, Scenario)

    def test_each_scenario_proves_with_scoped_pairs_of_its_steps(self):
        bulbs = {bulb for lamp in self.house.lamps for bulb in lamp.bulbs}
        for name, scenario in self.all.items():
            with self.subTest(name=name):
                self.assertTrue(scenario.proves)
                for proof in (*scenario.proves, *scenario.holds):
                    self.assertIsInstance(proof, Proof)
                    self.assertTrue(0 <= proof.first < proof.second < len(scenario.steps))
                    self.assertTrue(proof.bulbs or proof.switches)
                    self.assertTrue(set(proof.bulbs) <= bulbs and set(proof.switches) <= set(self.house.plugs))

    def test_each_proof_looks_only_at_what_its_scenario_acts_on(self):
        # Ruling 55: a whole-house diff cannot fail when the scenario's own input does nothing.
        house = self.house
        every = (tuple(sorted(bulb for lamp in house.lamps for bulb in lamp.bulbs)), tuple(house.plugs))
        subject = (('bulb_b1', 'bulb_b2', 'bulb_b3'), ())   # room_b: the room of the one placed remote
        lamp = (('bulb_b1', 'bulb_b2'), ())   # room_b's first lamp: the held lamp, the mid-fade lamp
        candle = (('bulb_b1', 'bulb_b2'), ())   # lamp_b1: the first reference candle lamp with the firmware candle
        expected = {name: subject for name in NAMES} | {
            'schedule_day': every, 'dst_spring': every, 'dst_autumn': every,
            'range_save': ((), ('switch.e2e_plug_1',)), 'plug_button': ((), ('switch.e2e_plug_1',)),
            'candle_lamp_evening': candle, 'person_change_then_expiry': lamp, 'ha_restart_mid_fade': lamp,
            'wall_power_cycle': (('bulb_b1',), ())}   # the cut bulb
        for name, scenario in self.all.items():
            with self.subTest(name=name):
                self.assertEqual({(proof.bulbs, proof.switches) for proof in (*scenario.proves, *scenario.holds)},
                                 {expected[name]})

    def test_midnight_weekend_holds_the_subject_room_across_the_weekday_starts(self):
        scenario = self.all['midnight_weekend']
        self.assertEqual([(proof.first, proof.second) for proof in scenario.holds], [(1, 2), (4, 5)])
        for proof in scenario.holds:
            before, after = local_at(scenario, proof.first), local_at(scenario, proof.second)
            weekday = {seed.entity: seed.state for seed in scenario.seeds}
            starts = [weekday['input_datetime.ls_house_night_start'], weekday['input_datetime.ls_house_day_start']]
            self.assertTrue(any(before.strftime('%H:%M:%S') < start < after.strftime('%H:%M:%S') for start in starts))

    def test_one_missing_role_fails_only_its_own_scenarios(self):
        house = replace(self.house, mode_switch=None, candle_lamps=())
        built = scenarios(house)
        self.assertEqual(built.names, NAMES)
        for name in ('mode_toggle', 'candle_lamp_evening'):
            with self.subTest(name=name), self.assertRaises(MissingRole):
                built[name]
        self.assertEqual(built['schedule_day'], self.all['schedule_day'])

    def test_a_scenario_that_cannot_be_built_is_still_a_golden_name(self):
        # `replay` checks a golden name against its recording; a builder's KeyError must not hide the name.
        built = scenarios(replace(self.house, overlay_rules=()))
        self.assertIn('person_change_then_expiry', built)
        self.assertNotIn('fuzz_x', built)
        self.assertFalse(hasattr(built, 'get'))   # nothing that could turn a builder's error into a default

    def test_the_candle_lamp_is_the_first_reference_candle_lamp_that_is_firmware_candle_capable(self):
        no_firmware = replace(self.house, candle_lamps=('light.lamp_a1',))
        with self.assertRaises(MissingRole):
            scenarios(no_firmware)['candle_lamp_evening']

    def test_overlay_rules_are_seeded_with_their_captured_attributes(self):
        captured = {rule.entity: rule for rule in self.house.overlay_rules}
        for name, scenario in self.all.items():
            for seed in scenario.seeds:
                if seed.entity in captured:
                    with self.subTest(name=name, rule=seed.entity):
                        self.assertEqual(seed.attributes, captured[seed.entity].attributes)
        for name in ('remote_presses', 'person_change_then_expiry'):
            with self.subTest(name=name):
                seeds = {seed.entity: seed.state for seed in self.all[name].seeds}
                self.assertEqual((seeds[AFTER_RULE], float(seeds[AFTER_MINUTES])), ('on', OVERLAY_MINUTES))

    def test_a_rule_the_house_did_not_capture_is_not_invented(self):
        house = replace(self.house, overlay_rules=())
        with self.assertRaises(MissingRole):
            scenarios(house)['person_change_then_expiry']

    def test_scenarios_use_only_the_house_entities(self):
        house = self.house
        helpers = {h.entity for h in house.helpers} | {rule.entity for rule in house.overlay_rules}
        bulbs = {bulb for lamp in house.lamps for bulb in lamp.bulbs}
        for name, scenario in self.all.items():
            with self.subTest(name=name):
                self.assertTrue({seed.entity for seed in scenario.seeds} <= helpers)
                self.assertEqual(len({seed.entity for seed in scenario.seeds}), len(scenario.seeds))
                for step in scenario.steps:
                    if isinstance(step, (PowerCut, PowerRestore)):
                        self.assertTrue(set(step.bulbs) <= bulbs)
                    elif isinstance(step, PressSwitch):
                        self.assertIn(step.entity, house.plugs)
                    elif isinstance(step, PersonLightChange):
                        self.assertTrue(set(step.entities) <= {lamp.lamp for lamp in house.lamps})
                    elif isinstance(step, Mqtt):
                        self.assertIn(step.topic, {remote.topic for remote in house.remotes})
                    elif isinstance(step, StateChanged):
                        self.assertEqual(step.entity, house.mode_switch)
                    elif isinstance(step, ScriptCall):
                        entity = step.data.get('entity')
                        self.assertTrue(entity is None or entity in house.plugs)

    def test_no_scenario_selects_breathe_or_colour_loop(self):
        for name, scenario in self.all.items():
            with self.subTest(name=name):
                effects = {profile['effect'] for profile in profiles(scenario).values()}
                self.assertFalse(effects & UNUSED)
                self.assertEqual('Candle' in effects, name == 'candle_lamp_evening')

    def test_remote_presses_each_press_kind_of_a_placed_remote_two_minutes_apart(self):
        scenario = self.all['remote_presses']
        presses = steps_of(scenario, Mqtt)
        remote = next(remote for remote in self.house.remotes if remote.room is not None)
        # The last press twice, so an overlay unlike the schedule is left for the expiry to end.
        self.assertEqual([step.payload for _, step in presses], [*remote.presses, remote.presses[-1]])
        self.assertEqual({step.topic for _, step in presses}, {remote.topic})
        for (first, _), (second, _) in zip(presses, presses[1:]):
            self.assertEqual(sum(step.seconds for step in scenario.steps[first:second] if isinstance(step, Advance)), 120)

    def test_schedule_day_is_a_start_then_24_hours(self):
        scenario = self.all['schedule_day']
        self.assertEqual(scenario.steps, (HaStart(), *[Advance(3600)] * 24))

    def test_midnight_weekend_runs_from_friday_evening_to_saturday_morning(self):
        scenario = self.all['midnight_weekend']
        first, last = scenario.start.astimezone(LOCAL), local_at(scenario, len(scenario.steps) - 1)
        self.assertEqual((first.weekday(), last.weekday()), (4, 5))
        self.assertGreaterEqual(first.hour, 17)
        self.assertLess(last.hour, 12)

    def test_dst_scenarios_cross_the_last_sunday_change_with_a_start_in_the_shifted_hour(self):
        for name, month in (('dst_spring', 3), ('dst_autumn', 10)):
            with self.subTest(name=name):
                scenario = self.all[name]
                first, last = scenario.start.astimezone(LOCAL), local_at(scenario, len(scenario.steps) - 1)
                self.assertNotEqual(first.utcoffset(), last.utcoffset())
                self.assertEqual(first.month, month)
                self.assertEqual(((first + timedelta(days=1)).weekday(), (first + timedelta(days=8)).month), (6, month + 1))
                starts = {seed.state for seed in scenario.seeds if seed.entity.endswith(('_start', '_weekend'))}
                self.assertIn('02:30:00', starts)

    def test_ha_restart_mid_fade_starts_twice(self):
        self.assertEqual(len(steps_of(self.all['ha_restart_mid_fade'], HaStart)), 2)

    def test_ha_restart_mid_fade_proves_the_fade_runs_on_through_the_restart(self):
        # The restart's right effect is none: the lamp is where it was just after it, and still fades after.
        scenario = self.all['ha_restart_mid_fade']
        second = steps_of(scenario, HaStart)[1][0]
        self.assertEqual([(proof.first, proof.second) for proof in scenario.holds], [(second - 1, second)])
        self.assertEqual([(proof.first, proof.second) for proof in scenario.proves], [(second, second + 1)])

    def test_wall_power_cycle_proves_the_restored_bulb_is_put_back(self):
        # After the restore the bulb is back at its old light; the scripts then give it the new block's. With no
        # cut it would show the new block at both, and with no recovery its old light at both.
        scenario = self.all['wall_power_cycle']
        [(restore, back)] = steps_of(scenario, PowerRestore)
        self.assertEqual([(p.first, p.second, p.bulbs) for p in scenario.proves], [(restore, restore + 1, back.bulbs)])

    def test_person_change_proves_the_hold_and_its_end_on_the_held_lamp(self):
        scenario = self.all['person_change_then_expiry']
        [(change, step)] = steps_of(scenario, PersonLightChange)
        held = tuple(sorted(b for lamp in self.house.lamps if lamp.lamp in step.entities for b in lamp.bulbs))
        self.assertEqual([(p.first, p.second, p.bulbs) for p in scenario.holds], [(change, change + 1, held)])
        self.assertEqual([(p.first, p.second, p.bulbs) for p in scenario.proves], [(change + 1, change + 2, held)])

    def test_wall_power_cycle_cuts_for_five_minutes(self):
        scenario = self.all['wall_power_cycle']
        [(cut, step)], [(restore, back)] = steps_of(scenario, PowerCut), steps_of(scenario, PowerRestore)
        self.assertEqual(step.bulbs, back.bulbs)
        self.assertEqual(scenario.steps[cut + 1:restore], (Advance(300),))
        for proof in scenario.proves:   # not proved by the cut or the restore alone (the world moving itself)
            self.assertFalse(proof.first == cut - 1 and proof.second in (cut, restore))

    def test_candle_lamp_evening_gives_the_candle_lamp_the_candle(self):
        for has_store in (True, False):
            with self.subTest(lamp_has_store=has_store):
                house = synthetic_house(candle_lamp_has_store=has_store)
                scenario = scenarios(house)['candle_lamp_evening']
                candled = {entity for entity, profile in profiles(scenario).items() if profile['effect'] == 'Candle'}
                lamp = next(lamp for lamp in house.lamps if lamp.lamp == 'light.lamp_b1')
                stores = [h for h in house.helpers if h.setting == 'light' and h.block == 'cosy']
                own = [h.entity for h in stores if h.lamp == lamp.lamp]
                room = [h.entity for h in stores if h.room == lamp.room and h.lamp is None]
                self.assertEqual(candled, set(own) if has_store else set(room))   # ruling 52

    def test_person_change_then_expiry_keeps_the_hold_past_the_next_block(self):
        # The captured next-block rule would end the hold at the boundary; it is off here, so the hold lasts
        # until the after-duration rule ends it (ruling 51).
        scenario = self.all['person_change_then_expiry']
        self.assertTrue(any(seed.entity == NEXT_BLOCK_RULE and seed.state == 'off' for seed in scenario.seeds))
        self.assertEqual(len(steps_of(scenario, PersonLightChange)), 1)


# --- recordings ------------------------------------------------------------------------------------------

START = datetime(2026, 11, 18, 12, tzinfo=LOCAL)


def checkpoint(step, level, t=0.0):
    return Checkpoint(step=step, t=t, bulbs={'bulb_a': On(level, Kelvin(2700), 'none'), 'bulb_b': Off()},
                      switches={'switch.x': 'off'}, dashboard={}, in_fade=frozenset(), not_ported=())


class Recordings(unittest.TestCase):
    scenario = Scenario('golden_x', START, (Seed('input_text.x', 'v', {'max': 255}),),
                        (HaStart(), Advance(60)), (Proof(0, 1, ('bulb_a',), ()),), (Proof(0, 1, ('bulb_b',), ()),))
    reference_run = BackendRun([checkpoint(0, 100), checkpoint(1, 120, 60.0)], {'software-candle-is-firmware-candle': 2})

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='e2e-golden-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_a_recording_round_trips(self):
        path = save('golden_x', self.scenario, self.reference_run, directory=self.directory)
        self.assertEqual(path.parent, self.directory)
        recording = load('golden_x', directory=self.directory)
        self.assertEqual((recording.scenario, recording.reference.checkpoints, recording.reference.adjustments),
                         (self.scenario, self.reference_run.checkpoints, self.reference_run.adjustments))
        self.assertEqual(recording.sources, sources_hash())

    def test_stale_recording_raises(self):
        save('golden_x', self.scenario, self.reference_run, directory=self.directory, sources='an older harness')
        with self.assertRaises(StaleRecording):
            replay('golden_x', directory=self.directory, current=lambda: {})
        save('golden_x', self.scenario, self.reference_run, directory=self.directory)
        changed = replace(self.scenario, steps=(HaStart(), Advance(120)))
        with self.assertRaises(StaleRecording):
            replay('golden_x', directory=self.directory, current=lambda: {'golden_x': changed})

    def test_a_missing_recording_is_an_error(self):
        with self.assertRaises(MissingRecording):
            replay('golden_x', directory=self.directory, current=lambda: {})

    def test_differ_uses_the_comparator(self):
        self.assertTrue(differ(checkpoint(0, 100), checkpoint(1, 120, 60.0)))
        self.assertFalse(differ(checkpoint(0, 100), checkpoint(1, 101, 60.0)))   # within LEVEL_STEPS

    def test_differences_are_written_only_when_there_are_some(self):
        path = self.directory / 'golden_x.differences.json'
        path.write_text('{"differences": []}')   # an old, empty dump
        same = compare([checkpoint(0, 100)], [checkpoint(0, 100)])
        self.assertIsNone(write_differences('golden_x', same, directory=self.directory))
        self.assertFalse(path.exists())
        apart = compare([checkpoint(0, 100)], [checkpoint(0, 140)])
        self.assertEqual(write_differences('golden_x', apart, directory=self.directory), path)
        self.assertEqual(len(json.loads(path.read_text())['differences']), len(apart.differences))

    def test_the_hash_covers_the_reference_run_and_the_captures_only(self):
        root = self.directory / 'root'
        modules = root / 'tests' / 'e2e'
        modules.mkdir(parents=True)
        (root / 'reference' / 'live').mkdir(parents=True)
        for name in ('env', 'world', 'router', 'codec', 'backend', 'runner', 'services', 'compare', 'golden', 'test_x'):
            (modules / f'{name}.py').write_text(name)
        (root / 'reference' / 'live' / 'capture.json').write_text('{}')
        (root / 'tests' / 'parity').mkdir()
        (root / 'tests' / 'parity' / 'portability.py').write_text('live_candidate')   # ruling 56: the whole module
        first = sources_hash(root)
        for name in ('compare', 'golden', 'test_x'):
            (modules / f'{name}.py').write_text('changed')
        self.assertEqual(sources_hash(root), first)
        for changed in (modules / 'world.py', root / 'reference' / 'live' / 'capture.json',
                        root / 'tests' / 'parity' / 'portability.py'):
            with self.subTest(changed=changed.name):
                before = sources_hash(root)
                changed.write_text('changed ' + changed.name)
                self.assertNotEqual(sources_hash(root), before)


# --- the real backends -----------------------------------------------------------------------------------

def last_of(checkpoints, step):
    return [c for c in checkpoints if c.step == step][-1]


@unittest.skipUnless(env.reference_available(), 'private reference or HA wrapper missing')
class Golden(unittest.TestCase):
    """Per scenario: the port agrees with the recording, and the recording proves something."""

    @classmethod
    def setUpClass(cls):
        from tests.e2e.runner import describe_house
        cls.house = describe_house()
        cls.scenarios = scenarios(cls.house)

    def recorded(self, name):
        return load(name).reference.checkpoints   # a missing recording raises MissingRecording: a failure, not a skip

    def agrees(self, name):
        result = replay(name)
        dump = write_differences(name, result)   # git-ignored: the differences name catalog entities
        self.assertEqual(len(result.differences), 0, f'{name}: {len(result.differences)} differences, listed in {dump}')

    def proves(self, name):
        checkpoints = self.recorded(name)
        scenario = self.scenarios[name]   # a missing role raises here, in this scenario's test only
        for proof in scenario.proves:
            with self.subTest(proves=(proof.first, proof.second)):
                self.assertTrue(differ(last_of(checkpoints, proof.first), last_of(checkpoints, proof.second), proof),
                                f'{name}: the reference shows the same scope after steps {proof.first} and {proof.second}')
        for proof in scenario.holds:
            with self.subTest(holds=(proof.first, proof.second)):
                self.assertFalse(differ(last_of(checkpoints, proof.first), last_of(checkpoints, proof.second), proof),
                                 f'{name}: the reference changed the scope between steps {proof.first} and {proof.second}')

    def test_candle_lamp_evening_runs_the_reference_candle(self):
        # Ruling 56: the scenario's lamp is one the reference runs its software candle on.
        self.assertGreater(load('candle_lamp_evening').reference.adjustments.get(SOFTWARE_CANDLE, 0), 0)

    def test_ha_restart_mid_fade_restarts_inside_a_fade(self):
        scenario = self.scenarios['ha_restart_mid_fade']
        second = steps_of(scenario, HaStart)[1][0]
        fading = last_of(self.recorded('ha_restart_mid_fade'), second - 1).in_fade
        for proof in (*scenario.proves, *scenario.holds):   # the proof's own bulbs fade at the restart
            self.assertTrue(set(proof.bulbs) <= fading)

    def test_wall_power_cycle_cuts_a_lit_bulb(self):
        scenario = self.scenarios['wall_power_cycle']
        [(cut, step)] = steps_of(scenario, PowerCut)
        before = last_of(self.recorded('wall_power_cycle'), cut - 1)
        self.assertTrue(all(isinstance(before.bulbs[bulb], On) for bulb in step.bulbs))

    def test_person_change_holds_across_the_next_block(self):
        scenario = self.scenarios['person_change_then_expiry']
        [(change, step)] = steps_of(scenario, PersonLightChange)
        bulbs = [bulb for lamp in self.house.lamps if lamp.lamp in step.entities for bulb in lamp.bulbs]
        checkpoints = self.recorded('person_change_then_expiry')
        held, later = last_of(checkpoints, change), last_of(checkpoints, change + 1)
        self.assertEqual(compare([replace(held, bulbs={b: held.bulbs[b] for b in bulbs})],
                                 [replace(later, step=held.step, t=held.t, bulbs={b: later.bulbs[b] for b in bulbs})]
                                 ).differences, ())


def _add_scenario_tests():
    for name in NAMES:
        setattr(Golden, f'test_{name}_agrees', lambda self, name=name: self.agrees(name))
        setattr(Golden, f'test_{name}_is_not_vacuous', lambda self, name=name: self.proves(name))


_add_scenario_tests()


if __name__ == '__main__':
    unittest.main()
