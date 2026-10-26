// Test-only dependency fixtures for native/UI pure plan contracts.
import {createInterface} from 'node:readline';
import {execute} from '../../src/runtime/engine.ts';
import {nativeHandlers} from '../../src/domain/native-controls.ts';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 try { process.stdout.write(JSON.stringify(execute(r,{...nativeHandlers,effects_catalog:()=>r.args.catalog,ls_plan:()=>r.args.current}))+'\n'); }
 catch(e) { process.stdout.write(JSON.stringify({error:String(e)})+'\n'); }
}
