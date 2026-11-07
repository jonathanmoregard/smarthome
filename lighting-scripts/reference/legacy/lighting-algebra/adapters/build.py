import json
from pathlib import Path
ROOT=Path('/tmp/lighting-algebra'); OUT=ROOT/'adapters'
def write(name,value):(OUT/(name+'.json')).write_text(json.dumps(value,indent=2)+'\n')
def response():return {'stop':'Return proposed control','response_variable':'result'}
script={'alias':'Effects · Native Control Adapter','description':'One stable override per control source and scope. Updates only supplied channels; effects claim their declared channels. Group activations share an effect instance. Room power is persistent state, never an override. Dry run returns proposed events/commands without changing state.','mode':'queued','max':50,'fields':{name:{'selector':{'object':{}}} for name in ['source','attribute','value']},'sequence':[
 {'action':'script.effects_catalog','response_variable':'catalog'},
 {'variables':{'is_profile':"{{ source.startswith('light.ls_') }}",'targets':'{{ catalog.groups.get(source,[source]) }}','stamp':'{{ as_timestamp(now()) }}','current':{'plan':{'base':{},'resolved':{'targets':{}}}}}},
 {'if':[{'condition':'template','value_template':"{{ not is_profile and attribute!='power' }}"}],'then':[{'action':'script.ls_apply','data':{'dry_run':True,'reason':'config'},'response_variable':'current'}]},
 {'variables':{'result':(OUT/'control_plan.jinja').read_text()}},
 {'if':[{'condition':'template','value_template':'{{ dry_run|default(false) }}'}],'then':[response()]},
 {'if':[{'condition':'template','value_template':'{{ not result.valid }}'}],'then':[{'stop':"{{ result.errors|join(' ') }}",'error':True}]},
 {'repeat':{'for_each':'{{ result.events }}','sequence':[{'choose':[
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.op=='power' }}"}],'sequence':[{'event':'ls_override','event_data':{'op':'power','area':'{{ repeat.item.area }}','on':'{{ repeat.item.on }}','via':'effects-house'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.op=='set' }}"}],'sequence':[{'event':'ls_override','event_data':{'op':'set','records':'{{ repeat.item.records }}','via':'effects-house'}}]}
 ]}]}},
 {'repeat':{'for_each':'{{ result.commands }}','sequence':[{'choose':[
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.action=='script.ls_store' }}"}],'sequence':[{'action':'script.ls_store','data':{'store':'{{ repeat.item.data.store }}','effect':'{{ repeat.item.data.effect }}'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.action=='light.turn_on' }}"}],'sequence':[{'choose':[
   {'conditions':[{'condition':'template','value_template':"{{ field in repeat.item.data }}".replace('field',repr(field))}],'sequence':[{'action':'light.turn_on','target':{'entity_id':'{{ repeat.item.target.entity_id }}'},'data':{field:'{{ repeat.item.data.'+field+' }}'}}]}
   for field in ['brightness','rgb_color','color_temp_kelvin']
  ],'default':[{'action':'light.turn_on','target':{'entity_id':'{{ repeat.item.target.entity_id }}'}}]}]},
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.action=='light.turn_off' }}"}],'sequence':[{'action':'light.turn_off','target':{'entity_id':'{{ repeat.item.target.entity_id }}'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.action=='homeassistant.turn_on' }}"}],'sequence':[{'action':'homeassistant.turn_on','target':{'entity_id':'{{ repeat.item.target.entity_id }}'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ repeat.item.action=='homeassistant.turn_off' }}"}],'sequence':[{'action':'homeassistant.turn_off','target':{'entity_id':'{{ repeat.item.target.entity_id }}'}}]}
 ]}]}}, response()]}
script['fields']['dry_run']={'name':'Dry Run','default':False,'selector':{'boolean':{}}}
write('effects_set',script)
print('Built effects_set adapter.')

# Standard CSS named colours are data from Pillow's installed colour table.
# No Pillow import/runtime dependency is added to HA.
import ast
pillow=Path('/nix/store/mrs7fg3byjbcaqfq6460mq9dqafv9dm9-python3.14-pillow-12.3.0/lib/python3.14/site-packages/PIL/ImageColor.py')
color_names={}
for node in ast.parse(pillow.read_text()).body:
 if isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name) and node.target.id=='colormap':
  for key,value in ast.literal_eval(node.value).items():
   color_names[key]=[int(value[i:i+2],16) for i in [1,3,5]]
  break
assert len(color_names)>100
macro=(ROOT/'core/scale_macros.jinja').read_text().split('{% macro mix_color')[0]
planner={'alias':'Effects · Normalize Native Control','description':'Read-only native service-data normalization into scoped channel records. Logical lamp identity comes from the existing catalogue. Room aggregates update room brightness; individual physical bulbs map to their containing lamp.','mode':'parallel','max':50,'fields':{name:{'selector':{'object':{}}} for name in ['sd','catalog','current','stamp']},'sequence':[{'variables':{'color_names':color_names,'result':macro+(OUT/'native_plan.jinja').read_text()}},{'stop':'Return channel records','response_variable':'result'}]}
write('effects_native_plan',planner)
old=json.loads((ROOT/'before/automation_lighting_schedule_lamp_change_detector.json').read_text())['config']
automation={**old,'description':'Capture only brightness/colour/effect channels explicitly changed by a user. Explicit user ON opens the affected room power gate without operating other lamps. Existing logical lamp membership is preserved. Automation and running-script contexts are ignored. Power-only calls create no override.','actions':[
 {'variables':{'sd':'{{ trigger.event.data.service_data | default({}) }}','stamp':'{{ as_timestamp(now()) }}'}},
 {'action':'script.effects_catalog','response_variable':'catalog'},
 {'action':'script.ls_apply','data':{'dry_run':True,'reason':'config'},'response_variable':'current'},
 {'action':'script.effects_native_plan','data':{'sd':'{{ sd }}','catalog':'{{ catalog }}','current':'{{ current }}','stamp':'{{ stamp }}'},'response_variable':'capture'},
 {'repeat':{'for_each':'{{ capture.power }}','sequence':[{'event':'ls_override','event_data':{'op':'power','area':'{{ repeat.item.area }}','on':True,'via':'app','who':'{{ trigger.event.context.user_id }}'}}]}},
 {'condition':'template','value_template':'{{ capture.records|count>0 }}'},
 {'event':'ls_override','event_data':{'op':'set','records':'{{ capture.records }}','via':'app','who':'{{ trigger.event.context.user_id }}'}}]}
write('automation_lighting_schedule_lamp_change_detector',automation)
print('Built native channel-only capture adapter and automation.')

sync=json.loads((ROOT/'before/effects_ui_sync.json').read_text())['config']
sync['description']='Mirror native controls from resolved logical targets and per-channel ownership. One unique effect name is displayed; mixed effects remain blank. Brightness uses logical level, colour constants (including Sara) use the resolved value. Sends only changed retained UI states, never device commands. Dry run skips discovery and returns messages.'
sync['fields']['dry_run']={'name':'Dry Run','default':False,'selector':{'boolean':{}}}
sync['sequence'][0]={'if':[{'condition':'template','value_template':'{{ not dry_run|default(false) }}'}],'then':[sync['sequence'][0]]}
sync['sequence'][2]['variables']['messages']=(OUT/'ui_messages.jinja').read_text()
sync['sequence'].insert(3,{'if':[{'condition':'template','value_template':'{{ dry_run|default(false) }}'}],'then':[{'variables':{'result':'{{ {"messages":messages} }}'}},{'stop':'Return UI messages without publishing','response_variable':'result'}]})
write('effects_ui_sync',sync)
print('Built per-channel UI mirror.')
