import unittest, sys, json, math
from pathlib import Path
from harness import Sim, Budget
CANDIDATE=sys.argv[1] if len(sys.argv)>1 and not sys.argv[1].startswith('-') else None
if CANDIDATE:sys.argv.pop(1)
L='light.living_room_yellow_retro_lamp'
STORE='input_text.ls_lamp_living_room_yellow_retro_lamp_day'
class Logic(unittest.TestCase):
 def sim(self):return Sim(CANDIDATE)
 def baseline(self,s,effect='Candle',scope='house'):
  s.run('ls_store',store=f'input_text.ls_{scope}_day',effect=effect)
 def test_house_effect_is_temporary_and_schedule_untouched(self):
  s=self.sim();before={e:d['state'] for e,d in s.state.items() if e.startswith('input_text.ls_')}
  s.run('effects_set',source=L,attribute='effect',value='Candle');s.reconcile()
  self.assertEqual(s.assignments()[L]['effect'],'Candle')
  self.assertEqual(before,{e:d['state'] for e,d in s.state.items() if e in before})
  self.assertEqual(s.attr('sensor.ls_overrides','overrides')['light:'+L]['value']['effect'],'Candle')
 def test_schedule_effect_updates_baseline_without_house_override(self):
  s=self.sim();s.run('effects_set',source='light.ls_house_day',attribute='effect',value='Candle')
  self.assertEqual(json.loads(s.states('input_text.ls_house_day'))['effect'],'Candle')
  self.assertEqual(s.attr('sensor.ls_overrides','overrides'),{})
  self.assertEqual(s.physical(),[])
  s.reconcile();self.assertEqual(set(s.assignments()),set(s.members))
 def test_house_room_lamp_inheritance(self):
  s=self.sim();self.baseline(s)
  s.run('ls_store',store='input_text.ls_living_room_day',effect='Breathe')
  s.run('ls_store',store=STORE,effect='Colour loop',own=False)
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Candle')
  s.put('input_boolean.ls_living_room_day_own_light','on')
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Breathe')
  s.run('ls_store',store=STORE,own=True)
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Colour loop')
  s.run('ls_store',store=STORE,own=False)
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Breathe')
  s.put('input_boolean.ls_living_room_day_own_light','off')
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Candle')
 def test_temporary_normal_masks_baseline_then_clear_releases(self):
  s=self.sim();self.baseline(s);s.reconcile()
  s.run('effects_set',source=L,attribute='effect',value='Normal light');s.reconcile()
  self.assertNotIn(L,s.assignments());self.assertEqual(s.plan()['profiles'][L]['effect'],'Normal light')
  s.event('ls_override',{'op':'clear_all'});s.reconcile();self.assertEqual(s.assignments()[L]['effect'],'Candle')
 def test_rgb_string_tuple_list_house(self):
  for rgb in ['255,134,7',(255,134,7),[255,134,7]]:
   with self.subTest(rgb=rgb):
    s=self.sim();s.run('effects_set',source=L,attribute='effect',value='Candle');s.reconcile()
    s.run('effects_set',source=L,attribute='rgb',value=rgb)
    self.assertNotIn(L,s.assignments());self.assertEqual(s.attr(L,'rgb_color'),[255,134,7])
    self.assertIsNone(s.attr('sensor.ls_overrides','overrides')['light:'+L]['value'])
 def test_rgb_string_tuple_list_schedule(self):
  for rgb in ['255,134,7',(255,134,7),[255,134,7]]:
   with self.subTest(rgb=rgb):
    s=self.sim();self.baseline(s)
    s.run('effects_set',source='light.ls_house_day',attribute='rgb',value=rgb)
    st=json.loads(s.states('input_text.ls_house_day'));self.assertEqual(st['effect'],'Normal light');self.assertEqual(st['m'],'hs')
    call=[c for c in s.calls if c['action']=='light.turn_on'][-1];self.assertEqual(call['data']['rgb_color'],[255,134,7]);self.assertEqual(s.physical(),[])
 def test_brightness_retains_active_effect(self):
  s=self.sim();s.run('effects_set',source=L,attribute='effect',value='Candle');s.reconcile()
  s.run('effects_set',source=L,attribute='brightness',value=200);s.reconcile()
  self.assertEqual(s.assignments()[L],{'effect':'Candle','brightness':200})
  s.run('effects_set',source='light.ls_house_day',attribute='effect',value='Candle')
  s.run('effects_set',source='light.ls_house_day',attribute='brightness',value=190)
  self.assertEqual(json.loads(s.states('input_text.ls_house_day'))['effect'],'Candle')
  self.assertEqual(json.loads(s.states('input_text.ls_house_day'))['b'],190)
 def test_explicit_temperature_clears_effect(self):
  s=self.sim();s.run('effects_set',source=L,attribute='effect',value='Candle');s.reconcile()
  s.run('effects_set',source=L,attribute='temperature',value=250)
  self.assertEqual(s.attr(L,'color_temp_kelvin'),4000);self.assertNotIn(L,s.assignments())
  self.baseline(s);s.run('effects_set',source='light.ls_house_day',attribute='temperature',value=250)
  self.assertEqual(json.loads(s.states('input_text.ls_house_day'))['effect'],'Normal light')
 def test_off_stays_off_after_clear(self):
  s=self.sim();self.baseline(s);s.reconcile();s.run('effects_set',source=L,attribute='power',value='OFF')
  self.assertEqual(s.states(L),'off');self.assertNotIn(L,s.assignments())
  s.event('ls_override',{'op':'clear_all'});s.calls=[];s.reconcile()
  self.assertEqual(s.states(L),'off')
  for c in s.physical():self.assertNotIn(L,c['target'].get('entity_id',[]))
 def test_clearing_uses_current_schedule_not_stale_snapshot(self):
  s=self.sim();self.baseline(s);s.run('ls_store',store='input_text.ls_house_cosy',effect='Normal light',brightness=70,kelvin=2200)
  s.run('effects_set',source=L,attribute='effect',value='Candle');s.reconcile()
  s.now=s.now.replace(hour=19);s.event('ls_override',{'op':'clear_all'});s.reconcile()
  self.assertNotIn(L,s.assignments());self.assertEqual(s.attr(L,'brightness'),70);self.assertEqual(s.attr(L,'color_temp_kelvin'),2200)
 def test_next_block_marks_expired_and_handback(self):
  s=self.sim();s.put('input_boolean.ls_ovr_next_block_on','on');s.run('effects_set',source=L,attribute='effect',value='Candle')
  s.now=s.now.replace(hour=19);p=s.plan();self.assertIn('light:'+L,p['stale_keys'])
  # Production event processing clears stale record; next reconcile uses current baseline.
  s.reconcile();s.reconcile();self.assertNotIn(L,s.assignments());self.assertNotIn('light:'+L,s.attr('sensor.ls_overrides','overrides'))
 def test_group_fanout_filters_owned_members(self):
  s=self.sim();c={'kind':'ct','ids':['light.living_room'],'brightness':150,'kelvin':3000,'transition':3}
  self.assertEqual(s.run('effects_filter_commands',commands=[c])['commands'],[c])
  s.run('effects_assign',assignments={L:{'effect':'Candle','brightness':150}})
  r=s.run('effects_filter_commands',commands=[c])['commands'];self.assertEqual(len(r),1);self.assertNotIn(L,r[0]['ids']);self.assertNotIn('light.living_room',r[0]['ids'])
  self.assertEqual(len(r[0]['ids']),6)
 def test_all_lamps_assignment_and_release(self):
  s=self.sim();s.run('effects_set',source='light.home',attribute='effect',value='Candle');s.reconcile();self.assertEqual(len(s.assignments()),16)
  s.run('effects_release',targets=[L]);self.assertEqual(len(s.assignments()),15)
 def engine(self,s,seconds=2):
  s.elapsed=0;s.max_elapsed=seconds
  try:s.run('effects_engine')
  except Budget:pass
 def test_off_unavailable_endpoint_and_bridge_gates(self):
  for state in ['off','unavailable','unknown']:
   s=self.sim();s.run('effects_assign',assignments={L:{'effect':'Candle','brightness':150}});s.put(L,state);s.calls=[];self.engine(s);self.assertEqual(s.physical(),[])
  s=self.sim();s.run('effects_assign',assignments={L:{'effect':'Candle','brightness':150}});s.put('binary_sensor.zigbee2mqtt_bridge_connection_state','off');s.calls=[];self.engine(s);self.assertEqual(s.physical(),[])
 def test_revision_change_stops_before_next_command(self):
  s=self.sim();s.run('effects_assign',assignments={L:{'effect':'Candle','brightness':150}});s.calls=[]
  s.on_delay=lambda sim:sim.put('sensor.ls_overrides','0',{'overrides':{}})
  self.engine(s);self.assertEqual(len(s.physical()),1)
 def test_shared_renderer_deterministic_bounded_and_color_correlated(self):
  s=self.sim();rows=[]
  for i in range(100):
   args={'timestamp':1_000_000+i*.15,'brightness':200,'transition':.3};a=s.run('effect_candle_frame',**args);self.assertEqual(a,s.run('effect_candle_frame',**args));self.assertTrue(50<=a['brightness']<=200);self.assertTrue(all(0<=v<=255 for v in a['rgb']));rows.append(a)
  rows.sort(key=lambda r:r['brightness']);self.assertEqual([r['rgb'][1] for r in rows],sorted(r['rgb'][1] for r in rows))
 def test_traffic_budget_no_retain_and_no_replay(self):
  s=self.sim();s.run('effects_assign',assignments={L:{'effect':'Candle','brightness':150},'light.meditation_floor_lamp':{'effect':'Candle','brightness':150}});s.calls=[];self.engine(s,5)
  p=s.physical();self.assertGreater(len(p),10)
  for a,b in zip(p,p[1:]):self.assertGreaterEqual(b['time']-a['time'],.099999)
  for c in p:self.assertEqual(c['data']['qos'],0);self.assertFalse(c['data']['retain'])
 def test_invalid_effect_and_target_fail_closed(self):
  s=self.sim();s.run('effects_set',source=L,attribute='effect',value='Party');self.assertEqual(s.events,[])
  s.run('effects_set',source='light.no_such_physical_target',attribute='effect',value='Candle');self.assertEqual(s.events,[])
 def test_native_effect_start_once_and_stop_before_release(self):
  s=self.sim();s.run('effects_assign',assignments={L:{'effect':'Colour loop','brightness':123}});s.calls=[];self.engine(s,2)
  p=s.physical();self.assertEqual(len(p),1);self.assertEqual(json.loads(p[0]['data']['payload']),{'brightness':123,'effect':'colorloop'})
  s.max_elapsed=None;s.calls=[];s.run('effects_release',targets=[L])
  self.assertEqual([json.loads(c['data']['payload'])['effect'] for c in s.physical()],['stop_colorloop','stop_effect'])
  self.assertEqual(s.assignments(),{})
 def test_engine_endpoint_unavailable_does_not_block_siblings(self):
  s=self.sim();owner='light.meditation_floor_lamp';endpoints=s.run('effects_catalog')['members'][owner]
  s.run('effects_assign',assignments={owner:{'effect':'Candle','brightness':150}})
  s.put(endpoints[0],'unavailable');s.calls=[];self.engine(s,1)
  topics={c['data']['topic'] for c in s.physical()};cat=s.run('effects_catalog')
  self.assertEqual(topics,{cat['topics'][endpoints[1]]})
 def test_schedule_power_and_missing_profile(self):
  s=self.sim();s.run('effects_set',source='light.ls_house_day',attribute='power',value='OFF')
  self.assertFalse(json.loads(s.states('input_text.ls_house_day'))['on'])
  s.run('effects_set',source='light.ls_house_day',attribute='brightness',value=190)
  self.assertTrue(json.loads(s.states('input_text.ls_house_day'))['on'])
  s.run('effects_set',source='light.ls_unknown_day',attribute='effect',value='Candle')
  self.assertEqual(s.states('input_text.ls_unknown_day'),'unknown')
  self.assertEqual(s.physical(),[])
 def test_normal_brightness_is_hold_and_does_not_invent_effect(self):
  s=self.sim();s.run('effects_set',source=L,attribute='brightness',value=80);s.reconcile()
  self.assertEqual(s.attr('sensor.ls_overrides','overrides')['light:'+L]['value'],{'brightness':80})
  self.assertNotIn(L,s.assignments());self.assertEqual(s.attr(L,'brightness'),80)
 def test_profile_effect_on_false_does_not_run(self):
  s=self.sim();s.run('ls_store',store='input_text.ls_house_day',effect='Candle',on=False);s.reconcile()
  self.assertEqual(s.assignments(),{});self.assertEqual(s.states(L),'off')
 def test_group_fully_effect_owned_emits_no_ordinary_write(self):
  s=self.sim();s.run('effects_set',source='light.living_room',attribute='effect',value='Candle');s.reconcile()
  self.assertEqual(s.run('effects_filter_commands',commands=[{'kind':'ct','ids':['light.living_room']}])['commands'],[])
 def test_real_snapshot_explains_disconnected_schedule_and_clear(self):
  s=self.sim();snapshot=json.loads(Path('/tmp/effects-promotion/live/states_snapshot.json').read_text())
  for e in snapshot:
   if e['entity_id'].startswith(('input_text.ls_','input_boolean.ls_','input_datetime.ls_','input_number.ls_')) or e['entity_id']=='sensor.ls_overrides':
    s.state[e['entity_id']]=e
    if e['entity_id'].startswith('input_text.ls_'):
     try:s.store(e['entity_id'],json.loads(e['state']))
     except json.JSONDecodeError:pass
  s.now=s.now.replace(hour=16,minute=25)
  self.assertEqual(s.plan()['profiles'][L]['effect'],'Normal light')
  self.assertEqual(s.plan(test_overrides={})['profiles'][L]['effect'],'Candle')
  s.event('ls_override',{'op':'clear_all'});s.reconcile()
  self.assertEqual(s.assignments()[L]['effect'],'Candle')
 def test_unknown_actions_blocked(self):
  s=self.sim()
  with self.assertRaisesRegex(AssertionError,'Unknown external action blocked'):s.service('unrecognized.service',{}, {})
if __name__=='__main__':unittest.main(verbosity=2)
