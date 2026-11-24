import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The rollout bridges run beside the old automations, one room at a time, so
 * each is a new automation that acts only for rooms whose port switch is on.
 * Made-up automations: a remote, the dashboard controls, the app lamp change,
 * the schedule engine, the recovery tick, a house-wide store writer and a
 * retained legacy automation.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/export-bridge.py', import.meta.url));
const automations: Record<string, object> = {
  lighting_studio_remote_center: { id: 'r1', alias: 'Studio remote center', mode: 'queued',
    triggers: [{ trigger: 'mqtt', topic: 'zigbee2mqtt/remote/action', payload: 'on' }],
    actions: [{ action: 'script.ls_remote_gesture_studio', data: { command: 'power' } }] },
  effects_native_light_controls: { id: 'n1', alias: 'Native controls', mode: 'queued',
    variables: { sources: { studio_lamp: 'light.studio' } },
    triggers: [{ trigger: 'mqtt', topic: 'house/v1/effect_preview/+/set/+' }],
    conditions: [{ condition: 'template', value_template: "{{ trigger.topic.split('/')[3] in sources }}" }],
    actions: [{ action: 'script.effects_set', data: {} }] },
  lighting_schedule_lamp_change_detector: { id: 'c1', alias: 'Lamp change', mode: 'queued',
    triggers: [{ trigger: 'event', event_type: 'call_service', event_data: { domain: 'light' } }],
    conditions: [{ condition: 'template', value_template: '{{ trigger.event.context.user_id is not none }}' }],
    actions: [{ event: 'ls_override', event_data: {} }] },
  lighting_schedule_engine: { id: 'e1', alias: 'Schedule engine', mode: 'parallel',
    triggers: [{ trigger: 'time_pattern', minutes: '/1', id: 'tick' }, { trigger: 'light.turned_on', target: { label_id: 'house_schedule' },
      id: 'lamp_on' }, { trigger: 'state', entity_id: ['light.studio'], id: 'lamp_state' }],
    actions: [{ action: 'script.ls_apply', data: { reason: 'tick' } }] },
  lighting_recover_pending_output: { id: 'p1', alias: 'Recover pending output', mode: 'single',
    triggers: [{ trigger: 'time_pattern', seconds: '/5' }],
    conditions: [{ condition: 'state', entity_id: 'binary_sensor.zigbee2mqtt_bridge_connection_state', state: 'on' },
      { condition: 'template', value_template: "{{ state_attr('sensor.ls_effects_runtime','handled_full') != 1 }}" }],
    actions: [{ action: 'script.turn_on', target: { entity_id: 'script.ls_render' } }] },
  lighting_schedule_override_store_writer: { id: 'w1', alias: 'Store writer', mode: 'queued',
    triggers: [{ trigger: 'event', event_type: 'ls_override' }], actions: [{ action: 'script.ls_commit', data: {} }] },
  house_schedule: { id: 'h1', alias: 'House schedule', triggers: [], actions: [] },
};
const catalog = { members: {}, groups: {}, effects: {}, remotes: { studio: { source: 'remote-studio', device_id: 'device-studio' } } };

async function exportRollout(extra: Record<string, object> = {}, remotes: object = catalog.remotes) {
  const root = await mkdtemp(join(tmpdir(), 'export-bridge-rollout-'));
  const source = join(root, 'automations'), output = join(root, 'out');
  await mkdir(source); await mkdir(join(root, 'scripts'));
  for (const [slug, config] of Object.entries({ ...automations, ...extra })) await writeFile(join(source, `${slug}.json`),
    JSON.stringify({ config }));
  await writeFile(join(root, 'catalog.json'), JSON.stringify({ ...catalog, remotes }));
  const run = spawnSync('python3', [SCRIPT, '--rollout', '--source', source, '--catalog', join(root, 'catalog.json'), '--output', output],
    { encoding: 'utf8' });
  const read = async (name: string) => JSON.parse(await readFile(join(output, name), 'utf8'));
  return { run, output, read };
}
type Bridge = { id: string; alias: string; triggers: Array<{ id?: string }>; conditions: Array<{ condition: string; value_template?: string;
  entity_id?: string }>; actions: Array<{ event: string; event_data: { script: string } }> };
const templates = (bridge: Bridge) => bridge.conditions.flatMap(condition => condition.value_template === undefined ? [] :
  [condition.value_template]).join('\n');

test('a rollout bridge is a new automation beside the old one', async () => {
  const { run, read } = await exportRollout();
  assert.equal(run.status, 0, run.stderr);
  const bridge: Bridge = await read('lighting_studio_remote_center.json');
  assert.equal(bridge.id, 'r1_port');
  assert.match(bridge.alias, /\(port\)/);
  assert.equal(bridge.actions[0]?.event_data.script, 'automation.lighting_studio_remote_center');
});

test('a remote\'s rollout bridge acts only when the remote\'s room is on the port', async () => {
  const { read } = await exportRollout();
  const text = templates(await read('lighting_studio_remote_center.json'));
  assert.match(text, /area_id\('device-studio'\)/);
  assert.match(text, /input_boolean\.ls_' ~ .* ~ '_on_port'/);
});

test('a remote with no catalog entry is refused', async () => {
  const { run } = await exportRollout({}, {});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /studio/);
});

test('the dashboard controls and the app lamp change keep their own conditions and add the room check', async () => {
  const { read } = await exportRollout();
  const native: Bridge = await read('effects_native_light_controls.json');
  assert.match(templates(native), /in sources/);
  assert.match(templates(native), /_on_port/);
  const change: Bridge = await read('lighting_schedule_lamp_change_detector.json');
  assert.match(templates(change), /user_id is not none/);
  assert.match(templates(change), /service_data/);
  assert.match(templates(change), /_on_port/);
});

test('the schedule engine\'s rollout bridge keeps only the lamp-on trigger, checked by the lamp\'s room', async () => {
  const { read } = await exportRollout();
  const engine: Bridge = await read('lighting_schedule_engine.json');
  assert.deepEqual(engine.triggers.map(trigger => trigger.id), ['lamp_on']);
  assert.match(templates(engine), /area_id\(trigger\.entity_id\)/);
});

test('the recovery bridge drops the check of the old scripts\' bookkeeping and runs while any room is on the port', async () => {
  const { read } = await exportRollout();
  const recover: Bridge = await read('lighting_recover_pending_output.json');
  assert.equal(recover.conditions.some(condition => condition.entity_id === 'binary_sensor.zigbee2mqtt_bridge_connection_state'), true);
  assert.doesNotMatch(templates(recover), /ls_effects_runtime/);
  assert.match(templates(recover), /_on_port/);
});

test('house-wide store writers get no rollout bridge and are listed as staying with the old scripts', async () => {
  const { output, read } = await exportRollout();
  const files = await readdir(output);
  assert.equal(files.includes('lighting_schedule_override_store_writer.json'), false);
  assert.equal(files.includes('house_schedule.json'), false);
  const manifest = await read('manifest.json');
  assert.equal(typeof manifest.old_only.lighting_schedule_override_store_writer, 'string');
  assert.deepEqual(manifest.script_bridges, []);
});

test('an automation the rollout does not know is refused rather than guessed', async () => {
  const { run } = await exportRollout({ lighting_mystery: { id: 'm1', alias: 'Mystery', triggers: [], actions: [] } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /lighting_mystery/);
});

test('closeout r2 A1: the app lamp change bridge forwards a person\'s turn_off, which the port reads as a lamp switched off', async () => {
  // The captured detector's own condition (reference/live/automations/lighting_schedule_lamp_change_detector.json:21)
  // passes only `turn_on`: the old scripts made no override of a power-only call. The port reads `turn_off` as a
  // person's off (src/adapter/codecs/inputs.ts:498), so its bridge must not keep that filter.
  const detector = { id: 'c1', alias: 'Lamp change', mode: 'queued',
    triggers: [{ trigger: 'event', event_type: 'call_service', event_data: { domain: 'light' } }],
    conditions: [{ condition: 'template', value_template: "{{ trigger.event.context.user_id is not none and trigger.event.data.service == 'turn_on' }}" }],
    actions: [{ event: 'ls_override', event_data: {} }] };
  const { run, read } = await exportRollout({ lighting_schedule_lamp_change_detector: detector });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(templates(await read('lighting_schedule_lamp_change_detector.json')), /service == 'turn_on'/);
});

test('the full cutover\'s lamp change bridge forwards a person\'s turn_off too, and keeps the rest of its condition', async () => {
  // Break: the cutover export (`bridge()`, no --rollout) keeps the detector's `service == 'turn_on'` filter, so after
  // the cutover a person's turn_off reaches the port only as a state change, and the next tick lights the lamp again.
  const root = await mkdtemp(join(tmpdir(), 'export-bridge-cutover-'));
  const source = join(root, 'automations'), output = join(root, 'out');
  await mkdir(source); await mkdir(join(root, 'scripts'));
  const condition = "{{ trigger.event.context.user_id is not none and trigger.event.data.service == 'turn_on' }}";
  await writeFile(join(source, 'lighting_schedule_lamp_change_detector.json'), JSON.stringify({ config: {
    ...automations.lighting_schedule_lamp_change_detector, conditions: [{ condition: 'template', value_template: condition }] } }));
  const run = spawnSync('python3', [SCRIPT, '--source', source, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const bridge: Bridge = JSON.parse(await readFile(join(output, 'lighting_schedule_lamp_change_detector.json'), 'utf8'));
  assert.doesNotMatch(templates(bridge), /service == 'turn_on'/);
  assert.match(templates(bridge), /turn_off/);
  assert.match(templates(bridge), /user_id is not none/);
});

test('a bridge forwards the automation\'s own variables, so the port reads the dashboard sources Home Assistant routed by', async () => {
  const { run, read } = await exportRollout();
  assert.equal(run.status, 0, run.stderr);
  const native = await read('effects_native_light_controls.json') as { actions: Array<{ event_data: { args: Record<string, string> } }> };
  assert.equal(native.actions[0]?.event_data.args.sources, '{{ sources }}');
  const remote = await read('lighting_studio_remote_center.json') as { actions: Array<{ event_data: { args: Record<string, string> } }> };
  assert.equal(Object.hasOwn(remote.actions[0]?.event_data.args ?? {}, 'sources'), false);
});
