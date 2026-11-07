import copy
import asyncio
import json
from pathlib import Path
import test_gestures
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.template import Template
from homeassistant.core import HomeAssistant

root=Path(__file__).parent
original=json.loads((root/'autogroup-originals.json').read_text())
output=copy.deepcopy(original)
catalog_template=(root/'auto-catalog.jinja').read_text()
emit_template=(root/'auto-emit-guard.jinja').read_text()
async def validate_templates():
    hass=HomeAssistant(str(root/'validate-ha'))
    Template(catalog_template,hass).ensure_valid()
    Template(emit_template,hass).ensure_valid()
    await hass.async_stop()
asyncio.run(validate_templates())
catalog=output['effects_catalog']['config']
catalog['sequence'].insert(1,{'variables':{'result':catalog_template}})
catalog['description']='Transport catalogue from fresh complete Zigbee memberships. Automatically generated room subgroups remain gated during acknowledged membership reconciliation.'
planner=output['effects_group_plan']['config']
text=planner['sequence'][0]['variables']['result']
old="'group':group.get('id',group.topic)}"
new="'group':group.get('id',group.topic), 'managed':group.get('managed',false), 'physical_members':group.get('physical_members',[])}"
assert text.count(old)==1
planner['sequence'][0]['variables']['result']=text.replace(old,new)
emitter=output['effects_emit']['config']
emitter['sequence'][1]['repeat']['sequence'].insert(2,{'variables':{'allowed':emit_template}})
emitter['description']+=' Verify multicast membership again immediately before publish; gated managed groups cannot race membership updates.'
for key,value in output.items():
    cv.SCRIPT_SCHEMA(copy.deepcopy(value['config']['sequence']))
(root/'auto-transport-candidate.json').write_text(json.dumps(output,indent=2)+'\n')
print('Validated templates and script schemas')
