"""Build pure runtime-managed Home Assistant script configuration artifacts."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
macros = (ROOT / 'scale_macros.jinja').read_text()
gradient_macros = (ROOT / 'gradient_macros.jinja').read_text()

def script(name, description, fields, template):
    config = {
        'alias': name, 'description': description, 'mode': 'parallel', 'max': 50,
        'fields': fields,
        'sequence': [{'variables': {'result': template}}, {'stop': 'Return pure result', 'response_variable': 'result'}],
    }
    return config

def field(default=None, required=False):
    result = {'selector': {'object': {}}}
    if default is not None:
        result['default'] = default
    if required:
        result['required'] = True
    return result

configs = {
    'effects_gradient_plan': script(
        'Effects · Compile manual gradients',
        'Pure versioned cache of continuous per-target gradient coefficients. Reuses matching anchors without colour conversion; no quantization, state reads or output.',
        {'base': field(required=True), 'warm_end': field([255,126,0]), 'cached': field({})},
        macros + '\n' + gradient_macros + '\n' + (ROOT / 'gradient_plan.jinja').read_text(),
    ),
    'effects_scale': script(
        'Effects · Resolve manual scale',
        'Pure manual adjustment around room/lamp Cosy=0 and Day=1 anchors. Preserves schedule anchors, bounds position to [-2,2], warms through 1950 K into RGB, and uses available upper brightness headroom.',
        {'day': field(required=True), 'cosy': field(required=True), 'position': field(required=True), 'warm_end': field([255,126,0])},
        macros + '\n{{ scale_value(day,cosy,position,warm_end)|from_json }}',
    ),
    'effects_resolve': script(
        'Effects · Resolve channel ownership',
        'Pure per-channel resolver. Latest field timestamp wins across applicable scopes, lexical record-key breaks ties. Effective period is supplied upstream. Keeps lamp ontology, intensity, legacy holds, Sara policy and power distinct. No state reads or external actions.',
        {'base': field(required=True), 'overrides': field({}), 'catalog': field(required=True), 'sara': field(False), 'private': field([]), 'power': field({}), 'warm_end': field([255,126,0]), 'gradients': field({})},
        macros + '\n' + gradient_macros + '\n' + (ROOT / 'resolve.jinja').read_text(),
    ),
}
for name, config in configs.items():
    (ROOT / f'{name}.json').write_text(json.dumps(config, indent=2) + '\n')
print('Built ' + ', '.join(configs))
