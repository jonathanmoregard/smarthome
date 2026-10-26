"""Execute unchanged captured HA actions and typed adapters against dry dependency sinks."""
import asyncio, copy, json, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'parity'))
from portability import ROOT, dependencies
dependencies()
from adapters import equal_results
from homeassistant.core import Context, HomeAssistant, SupportsResponse, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script, async_validate_actions_config

NOW = datetime(2026, 10, 26, 12, tzinfo=timezone.utc)
RESPONSES = {'effects_catalog': {}, 'ls_apply': {}, 'effects_native_plan': {'power': [{'area': 'studio'}], 'records': [{'kind': 'level', 'target': 'light.a', 'value': 70}]}}
NODE = """
import readline from 'node:readline';
import {execute} from './src/runtime/engine.ts';
import {automationHandlers} from './src/domain/automations.ts';
for await (const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line), handlers={...automationHandlers,effects_candle_sync_resume:()=>null};
 for (const name of r.dependencies) handlers[name]=(ctx,args)=>{ctx.emit('script.'+name,args);return r.responses[name]??null;};
 try {const out=execute(r,handlers);process.stdout.write(JSON.stringify(out)+'\\n');}
 catch(e) {process.stdout.write(JSON.stringify({error:String(e)})+'\\n');}
}
"""
def normalize(calls):
 out=[]
 for call in calls:
  data={**call['data'],**call.get('target',{})}
  if isinstance(data.get('entity_id'),str):data['entity_id']=[data['entity_id']]
  out.append({'service':call['service'],'data':data})
 return out

def state(**values):
 return {key:{'state':value if isinstance(value,str) else value[0], 'attributes':{} if isinstance(value,str) else value[1]} for key,value in values.items()}

async def main():
 configs={p.stem:json.loads(p.read_text())['config'] for p in (ROOT/'reference/live/automations').glob('*.json')}
 base=state(**{
  'sensor.ls_effects_runtime':('1',{'assignments':{'light.a':{'on':True}},'handled_full':1,'handled_rooms':{'studio':1}}),
  'sensor.ls_overrides':('1',{'full_version':2,'pending_rooms':{'studio':2},'overrides':{'expired':{'when':NOW.timestamp()-60},'fresh':{'when':NOW.timestamp()-59},'bad':{'when':'invalid'}}}),
  'binary_sensor.zigbee2mqtt_bridge_connection_state':'on','script.effects_engine':'off',
  'input_boolean.ls_ovr_after_on':'on','input_number.ls_ovr_after_min':'1','input_boolean.ls_ovr_at_on':'on',
  'input_number.ls_range_bright_min':'50','input_number.ls_range_bright_max':'100','input_number.ls_range_cosy_min':'0','input_number.ls_range_cosy_max':'40'})
 cases=[]
 def add(name,trigger,extra=None,states=None):cases.append((name,trigger,extra or {},states or base))
 for name,config in configs.items():
  if '_remote_' in name:
   action=config['actions'][0];room=action['action'].removeprefix('script.ls_remote_gesture_')
   add(name,{'id':'up','payload':'off','payload_json':{'action':'color_temperature_move','action_color_temperature':285}},{'room':room})
 add('effects_native_light_controls',{'topic':'house/v1/effect_preview/ep_home/set/power','payload':'OFF'},{'sources':configs['effects_native_light_controls']['variables']['sources']})
 add('effects_native_light_controls',{'topic':'house/v1/effect_preview/ep_home/set/invalid','payload':'OFF'},{'sources':configs['effects_native_light_controls']['variables']['sources']})
 for attribute,payload in [('brightness','87'),('temperature','370'),('rgb','255,100,0'),('effect','Candle')]:
  add('effects_native_light_controls',{'topic':f'house/v1/effect_preview/ep_home/set/{attribute}','payload':payload},{'sources':configs['effects_native_light_controls']['variables']['sources']})
 add('effects_candle_group_state',{'id':'groups','payload_json':[{'friendly_name':'fx_candle_active','id':1100,'members':[{'ieee_address':'0xa','endpoint':1}]}]})
 add('effects_candle_group_state',{'id':'groups','payload_json':[]})
 for token in ['candle:confirmed','unrelated']:
  add('effects_candle_group_state',{'id':'response','payload_json':{'transaction':token,'status':'ok'}})
 add('effects_candle_membership',{})
 add('effects_lifecycle',{})
 for trigger in ['start','periodic']:add('effects_refresh_native_light_controls',{'id':trigger})
 for trigger in ['tick','config','lamp_on']:add('lighting_schedule_engine',{'id':trigger,'entity_id':'light.a'})
 for trigger in ['after','at']:add('lighting_schedule_end_overrides',{'id':trigger})
 dated=copy.deepcopy(base);dated['sensor.ls_overrides']['attributes']['overrides']['expired']['when']='2026-10-26T11:59:00+00:00'
 add('lighting_schedule_end_overrides',{'id':'after'},states=dated)
 add('lighting_schedule_override_store_writer',{'event':{'data':{'op':'clear_all','who':''},'context':{'user_id':'person'}}})
 for trigger,user in [('on','person'),('on',None),('off','person')]:add('lighting_schedule_sara_mode_switch',{'id':trigger,'to_state':{'context':{'user_id':user}}})
 add('lighting_schedule_lamp_change_detector',{'event':{'data':{'service':'turn_on','service_data':{'entity_id':'light.a','brightness':70}},'context':{'id':'manual','user_id':'person'}}})
 add('switch_lamps_validate_house_defaults',{})
 invalid=copy.deepcopy(base);invalid['input_number.ls_range_bright_min']['state']='101'
 add('switch_lamps_validate_house_defaults',{},states=invalid)
 add('lighting_recover_pending_output',{})
 offline=copy.deepcopy(base);offline['binary_sensor.zigbee2mqtt_bridge_connection_state']['state']='off'
 add('lighting_recover_pending_output',{},states=offline)
 proc=subprocess.Popen(['node','--experimental-strip-types','--input-type=module','-e',NODE],cwd=ROOT,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
 comparisons=0
 try:
  with tempfile.TemporaryDirectory(prefix='automation-native-') as temporary:
   hass=HomeAssistant(temporary)
   for name,trigger,extra,states in cases:
    calls=[];events=[]
    for entity,item in states.items():hass.states.async_set(entity,item['state'],item['attributes'])
    @callback
    def event_listener(event):events.append({'event':event.event_type,'data':dict(event.data)})
    unsubscribe=hass.bus.async_listen('ls_override',event_listener)
    async def service(call):
     data=dict(call.data);calls.append({'service':f'{call.domain}.{call.service}','data':data})
     return copy.deepcopy(RESPONSES.get(call.service,{}))
    dependencies=['effects_set','effects_ui_sync','ls_commit','ls_apply','effects_catalog','effects_native_plan']
    dependencies += [configs[n]['actions'][0]['action'].removeprefix('script.') for n in configs if '_remote_' in n]
    for dependency in dependencies:hass.services.async_register('script',dependency,service,supports_response=SupportsResponse.OPTIONAL)
    hass.services.async_register('script','turn_on',service)
    hass.services.async_register('variable','update_sensor',service)
    config=configs[name]
    actions=await asyncio.wait_for(async_validate_actions_config(hass,cv.SCRIPT_SCHEMA(config.get('conditions',[])+config['actions'])),5)
    script=Script(hass,actions,name,'automation')
    with patch('homeassistant.util.dt.now',return_value=NOW),patch('homeassistant.util.dt.utcnow',return_value=NOW):
     await asyncio.wait_for(script.async_run({'trigger':trigger,**config.get('variables',{})},context=Context()),10)
     await asyncio.wait_for(hass.async_block_till_done(),10)
    request={'script':'automation.'+name,'args':{'trigger':trigger,**extra},'snapshot':{'state':states,'areas':{},'members':[],'now':NOW.isoformat()},'dependencies':dependencies,'responses':RESPONSES}
    proc.stdin.write(json.dumps(request)+'\n');proc.stdin.flush();actual=json.loads(proc.stdout.readline())
    assert 'error' not in actual,(name,actual)
    try:
     equal_results(normalize(actual['calls']),normalize(calls))
     equal_results(actual['events'],events)
    except AssertionError:
     print('Native automation mismatch:',name,trigger);raise
    comparisons+=1
    unsubscribe()
   await asyncio.wait_for(hass.async_stop(),5)
 finally:
  proc.stdin.close();proc.wait(timeout=10)
 print(json.dumps({'native_automation_comparisons':comparisons,'failures':0}))
asyncio.run(main())
