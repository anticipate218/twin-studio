import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from '../web/demo-api.js';

const seed = { model: {title:'Synthetic',size:320,gaussians:10}, buildings:{aligned:true,synthetic:true,buildings:[]}, materials:[{id:'brick-demo',title:'砖墙示例',file:'materials/brick.png'}] };
test('static demo assets respect a GitHub Pages project subpath', async () => {
  const {api}=createDemoClient(seed,{assetBase:'https://example.test/twin-studio/demo/'});
  assert.equal((await api.models()).models[0].url,'https://example.test/twin-studio/demo/models/demo_city.splat');
  assert.equal((await api.buildings('demo_city')).evidence_api,'https://example.test/twin-studio/demo/evidence');
  assert.equal((await api.run('brick-demo')).score,null);
  assert.equal((await api.runs()).runs[0].kind,'demo');
});
test('server tasks are explicitly unavailable rather than simulated as successful', async () => {
  const {api}=createDemoClient(seed);
  assert.equal((await api.system()).agent.can_generate,false);
  await assert.rejects(api.agentRun({}),/部署完整版/);
  await assert.rejects(api.reconStart({}),/部署完整版/);
});
test('GLB exports stay in the browser session and preserve downloadable bytes', async () => {
  let stored;
  const {api}=createDemoClient(seed,{createObjectURL:blob=>{stored=blob;return 'blob:test';}});
  const blob=new Blob(['glTFpayload'],{type:'model/gltf-binary'});
  await api.saveExport('scene.glb',blob);
  assert.equal(stored,blob);
  assert.equal((await api.exports()).exports[0].url,'blob:test');
  await assert.rejects(api.saveExport('../unsafe.glb',blob),/无效/);
  await assert.rejects(api.saveExport('bad.glb',new Blob(['oops'])),/不是GLB/);
  assert.equal((await createDemoClient(seed).api.exports()).exports.length,0);
});
