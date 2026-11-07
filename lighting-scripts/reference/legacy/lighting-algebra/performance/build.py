"""Build staged runtime candidates; deployment is a separate MCP operation."""
import json
from pathlib import Path
from pipeline import build as pipeline
from room_plan import build_scripts
from transport import transform

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'candidate'
OUT.mkdir(exist_ok=True)
configs={p.stem:json.loads(p.read_text()) for p in (ROOT/'before').glob('*.json')}
live=json.loads((ROOT/'before-live.json').read_text())
for name,value in live['scripts'].items():configs[name]=value['config']
for name,value in live['automations'].items():configs['automation_'+name]=value['config']
before=json.loads(json.dumps(configs))
configs.update(build_scripts(configs))
configs.update(pipeline(configs))
configs.update(transform(configs))

# Keep interactive publication timing in the enclosing dispatch trace even when
# rapid animation calls evict the emitter's own trace.
emit=configs['effects_emit']
emit['sequence'][0]['variables']['published_at']=[]
send=emit['sequence'][1]['repeat']['sequence'][-1]['then']
send.insert(0,{'variables':{'published_at':'{{ published_at+[as_timestamp(now())] }}'}})
emit['sequence'][-2]['variables']['result']=emit['sequence'][-2]['variables']['result'].replace("{'completed':", "{'published_at':published_at,'completed':")

for name,config in configs.items():(OUT/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
changed=[name for name,value in configs.items() if value!=before.get(name)]
(ROOT/'manifest.json').write_text(json.dumps({'changed':changed},indent=2)+'\n')
print('Built',len(configs),'configs;',len(changed),'changed:',', '.join(changed))
