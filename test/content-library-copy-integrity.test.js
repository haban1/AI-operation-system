import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createContentLibrary} from '../src/services/content-library.js';

async function setup(t, changeBytes) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'library-copy-integrity-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source');await fs.mkdir(source);
  const file=path.join(source,'fixture.png'),bytes=Buffer.from('immutable source fixture bytes');
  await fs.writeFile(file,bytes);
  const originalOpen=fs.open.bind(fs);let changed=false;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await originalOpen(...args);
    if(args[0]===file){
      const stat=handle.stat.bind(handle);let calls=0;
      handle.stat=async()=>{
        if(++calls===2){
          changed=true;
          if(changeBytes){const replacement=Buffer.from(bytes);replacement[0]^=1;await fs.writeFile(file,replacement);}
          else await fs.chmod(file,0o600);
        }
        const result=await stat();
        // Guarantee the simulated metadata race on filesystems with coarse times.
        if(calls===2 && !changeBytes)return {...result,ctimeMs:result.ctimeMs+1};
        return result;
      };
    }
    return handle;
  });
  const library=createContentLibrary({contentLibraryDir:path.join(root,'library'),contentLibrarySignalRoot:source},{
    collectSources:async()=>({entries:[{source:'automatic',sourceId:'fixture',rootPath:source,filePath:file}],sources:[]}),
    inspectMedia:async()=>({type:'image',width:64,height:64}),
  });
  return {root,library,bytes,changed:()=>changed};
}

test('metadata-only changes during copy retain the verified original bytes',async t=>{
  const ctx=await setup(t,false),result=await ctx.library.list();
  assert.equal(ctx.changed(),true);assert.equal(result.pendingItems.length,1);
  assert.equal(result.pendingItems[0].sha256,createHash('sha256').update(ctx.bytes).digest('hex'));
  const media=await fs.readdir(path.join(ctx.root,'library/media'));
  assert.deepEqual(await fs.readFile(path.join(ctx.root,'library/media',media[0])),ctx.bytes);
  assert.equal(result.items.length,0);
});

test('same-size byte changes during copy still reject the import and remove partial media',async t=>{
  const ctx=await setup(t,true),result=await ctx.library.list();
  assert.equal(ctx.changed(),true);assert.equal(result.pendingItems.length,0);
  assert.equal(result.sources[0].rejectedCount,1);
  assert.deepEqual(await fs.readdir(path.join(ctx.root,'library/media')),[]);
});
