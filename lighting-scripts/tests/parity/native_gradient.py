"""Supplement: native frozen gradient oracle against TypeScript public functions."""
import json,asyncio,random,subprocess,tempfile
from portability import dependencies,ROOT
dependencies()
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template

async def main():
 temporary=tempfile.TemporaryDirectory(prefix='smarthome-gradient-native-')
 hass=HomeAssistant(temporary.name)
 source=(ROOT/'reference/legacy/lighting-algebra/tests/test_gradient_reference.jinja').read_text()
 template=Template(source+'\n{% set n=namespace(v=[]) %}{% for p in positions %}{% set n.v=n.v+[scale_value(day,cosy,p,warm_end)|from_json] %}{% endfor %}{{ {"samples":n.v} }}',hass)
 rng=random.Random(28012026)
 edges=[-8,-2,-1.999999999,-1.000000001,-1,-.999999999,-.000000001,0,.000000001,.999999999,1,1.000000001,2,8]
 profiles=[({'brightness':243.25,'color':{'kelvin':4737}},{'brightness':111.75,'color':{'rgb':[253,137,21]}})]
 for index in range(180):
  def color(rgb): return {'rgb':[rng.uniform(0,255) for _ in range(3)]} if rgb else {'kelvin':rng.uniform(1000,10000)}
  profiles.append(({'brightness':rng.uniform(0,255),'color':color(index%2)},{'brightness':rng.uniform(0,255),'color':color(index%4>=2)}))
 cases=[{'day':day,'cosy':cosy,'warm_end':[rng.uniform(0,255) for _ in range(3)],'positions':edges+[rng.uniform(-2,2) for _ in range(25)]} for day,cosy in profiles]
 proc=subprocess.run(['node','--experimental-strip-types',str(ROOT/'tests/parity/gradient_rpc.mjs')],input='\n'.join(json.dumps(c) for c in cases)+'\n',text=True,capture_output=True,check=True)
 actual=[json.loads(line) for line in proc.stdout.splitlines()]
 for index,(case,result) in enumerate(zip(cases,actual,strict=True)):
  expected=template.async_render(case,strict=True)['samples']
  assert result['scale']==expected,('scale',index,case,result['scale'],expected)
  assert result['gradient']==expected,('gradient',index,case,result['gradient'],expected)
 print(json.dumps({'native_ha_frozen_reference_samples':sum(len(c['positions']) for c in cases),'profiles':len(cases),'typescript_scale_matches':True,'typescript_compiled_gradient_matches':True}))
 await hass.async_stop()
 temporary.cleanup()
asyncio.run(main())
