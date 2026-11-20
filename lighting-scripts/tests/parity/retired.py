"""Legacy cases retired by a deliberate behaviour change, never by a regression.

Each entry names an immutable legacy test whose assertion is about behaviour the
port no longer has by decision. `run.py` removes it from the suite on BOTH
backends before running, so neither counts it, and `gate.py` lists every entry
in its report with the reason. A retired case is never silently absent.

Removing is not skipping: a skipped test still counts in `testsRun`, and the
gate's clean count is `tests - failed`, so a skip would count as a pass.

Firmware candle (2026-11-19). Candle runs on the bulb (Innr firmware, Zigbee2MQTT
`effect: channel_change`): the port sends colour and ceiling once, then the
trigger, and streams nothing. Every case below uses a Candle-on-both-channels
fixture and asserts that the software candle streams engine frames, calls its
renderer, or flickers between frames. All twelve passed on the reference
backend, so the gate's clean count moves 244 -> 232 and nothing else does. The
other modules that mention Candle assert resolution (which lamp holds the
claim, intensity, ownership); they are unchanged and still compared.

Bulb effects (2026-11-19). Breathe and Colour loop also run on the bulbs
(Zigbee2MQTT `effect: breathe` / `effect: colorloop`, sent once after the light),
so the frame renderers and the frame engine are gone. Six more cases: four drive
`effects_engine` through `bounded_engine`, one asserts the Colour loop colour
changes between rendered frames, and one pins that the legacy pacing transform
emits an `effects_engine` script. All six passed on the reference backend, so the
clean count moves 232 -> 226. Kept, because they still pass identically and
assert behaviour the port still has: the two `effects_emit` cases left in
test_effect_pacing.py, the ten emitter/grouping cases left in test_transport.py,
and all fifteen cases of test_performance_pipeline.py (the commit/render/ack
pipeline, which does not stream).

Gradual off -> on fade (2026-11-20, "Scheduled fades are gradual in both
directions"). A moving stage that starts off and ends lit now switches the lamp
on at level 1 in the lit end's colour and ramps to the lit end's level; today's
scripts jump straight to the lit end. One case asserts that jump: its wake fade
from an off night at 06:15 (p = 0.5) expects the day level 250 where the port
now gives 126. It passed on the reference backend, so the clean count moves
226 -> 225. Its other two rows (both ends lit, lit night to off day) still pass
on the port, but a retirement removes the whole case. The wake cases with a lit
night, the explicit-period case and the regular-fade case in the same module are
unchanged and still compared.
"""

_STREAMED = 'Asserts the engine streams software Candle frames; the bulb firmware renders Candle and the engine sends it nothing.'
_ENGINE = 'Drives the frame engine (effects_engine via bounded_engine); the bulbs run every effect and there is no engine.'

RETIRED = {
    'lighting-algebra/tests/test_effect_pacing.py': {
        name: _STREAMED for name in (
            'test_animation_admits_one_command_per_fresh_frame',
            'test_compatible_multicast_keeps_group_safety_and_fairness',
            'test_generation_change_after_render_drops_frame_then_resumes',
            'test_generation_change_during_wait_uses_latest_snapshot',
            'test_generation_updates_preserve_rotation_and_spacing',
            'test_latest_partial_channel_assignment_is_rendered_after_wait',
            'test_round_robin_serves_all_endpoints_fairly',
            'test_slow_iteration_does_not_catch_up_with_burst',
            'test_temporary_revision_mismatch_resumes_same_rotation',
        )
    } | {
        name: _ENGINE for name in (
            'test_current_power_off_and_bridge_off_reject_output',
            'test_interactive_output_during_animation_wait_is_immediate',
            'test_ownership_change_between_render_and_admission_is_rejected',
            'test_revision_change_during_wait_stops_without_stale_frame',
        )
    } | {
        'test_transform_does_not_mutate_input_and_supports_controller_override':
            'Pins that the legacy pacing transform emits an effects_engine script; the port has no engine.',
    },
    'lighting-algebra/tests/test_room_wake_baseline.py': {
        'test_rgb_and_profile_off_fades_match_existing_planner':
            'Asserts a wake fade from an off night jumps to the day level; the port ramps up from level 1 (scheduled fades are gradual in both directions).',
    },
    'lighting-algebra/tests/test_transport.py': {
        'test_engine_uses_bounded_shared_transport': _STREAMED,
        'test_one_candle_sample_per_lamp_not_per_bulb_or_channel':
            'Counts calls to the software renderer effect_candle_frame, which no longer exists.',
        'test_constant_colour_overrides_candle_colour_but_keeps_flicker':
            'Asserts the frame plan flickers Candle brightness between frames; the plan now sends the ceiling and the bulb flickers.',
        'test_colour_effect_does_not_take_constant_brightness':
            'Asserts the Colour loop colour changes between rendered frames; the bulb runs colorloop and the plan sends no colour for it.',
    },
}


def retired_cases():
    """Every retired case, flat, for the gate report."""
    return [{'module': module, 'test': test, 'reason': reason}
            for module, tests in sorted(RETIRED.items()) for test, reason in sorted(tests.items())]
