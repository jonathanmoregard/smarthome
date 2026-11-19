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
"""

_STREAMED = 'Asserts the engine streams software Candle frames; the bulb firmware renders Candle and the engine sends it nothing.'

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
    },
    'lighting-algebra/tests/test_transport.py': {
        'test_engine_uses_bounded_shared_transport': _STREAMED,
        'test_one_candle_sample_per_lamp_not_per_bulb_or_channel':
            'Counts calls to the software renderer effect_candle_frame, which no longer exists.',
        'test_constant_colour_overrides_candle_colour_but_keeps_flicker':
            'Asserts the frame plan flickers Candle brightness between frames; the plan now sends the ceiling and the bulb flickers.',
    },
}


def retired_cases():
    """Every retired case, flat, for the gate report."""
    return [{'module': module, 'test': test, 'reason': reason}
            for module, tests in sorted(RETIRED.items()) for test, reason in sorted(tests.items())]
