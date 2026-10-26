"""Native HA evidence of live/historical Candle behavior, not a changed expectation."""
import json,asyncio,tempfile
from pathlib import Path
from portability import dependencies,ROOT
dependencies()
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template

async def main():
 temporary=tempfile.TemporaryDirectory(prefix='smarthome-native-drift-')
 hass=HomeAssistant(temporary.name)
 base={'area':'living','is_room':False,'period':'cosy','brightness':110,'color':{'kelvin':2300}}
 result={}
 for label,path in [('historical',ROOT/'reference/legacy/lighting-algebra/core/effects_resolve.json'),('live',ROOT/'reference/live/scripts/effects_resolve.json')]:
  doc=json.loads(path.read_text());config=doc.get('config',doc)
  template=Template(config['sequence'][0]['variables']['result'],hass)
  for lamp in ['lamp_a','light.living_room_yellow_retro_lamp']:
   args={k:v['default'] for k,v in config['fields'].items() if 'default' in v}
   args.update(base={lamp:base},catalog={'effects':{'Candle':{'channels':['brightness','color']}}},overrides={'candle':{'kind':'channels','scope':'lamp','target':lamp,'when':'2026-10-26T12:00:00+01:00','value':{'channels':{'brightness':{'kind':'effect','effect':'Candle','instance':'shared','updated':1}}}}})
   value=template.async_render(args,strict=True)
   result[label+':'+lamp]=value['targets'][lamp]['brightness']
 print(json.dumps(result,indent=2))
 assert result['historical:lamp_a']['kind']=='effect'
 assert result['live:lamp_a']['kind']=='constant'
 assert result['live:light.living_room_yellow_retro_lamp']['kind']=='effect'
 await hass.async_stop()
 temporary.cleanup()
asyncio.run(main())
