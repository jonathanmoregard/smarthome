import {createInterface} from 'node:readline';
import {scaleValue} from '../../src/domain/scale.ts';
import {compileGradient,sampleGradient} from '../../src/domain/gradient.ts';
for await (const line of createInterface({input:process.stdin})) {
 const c=JSON.parse(line); const curve=compileGradient(c.day,c.cosy,c.warm_end);
 process.stdout.write(JSON.stringify({scale:c.positions.map(p=>scaleValue(c.day,c.cosy,p,c.warm_end)),gradient:c.positions.map(p=>sampleGradient(curve,p))})+'\n');
}
