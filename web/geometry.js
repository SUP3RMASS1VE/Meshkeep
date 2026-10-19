import * as THREE from 'three';

export function packedTriangles(object) {
  object.updateMatrixWorld(true);
  let count=0;
  object.traverse(mesh=>{if(mesh.isMesh)count+=(mesh.geometry.index?.count||mesh.geometry.attributes.position.count)/3});
  const result=new Float32Array(count*9), point=new THREE.Vector3();let offset=0;
  object.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const position=mesh.geometry.attributes.position,index=mesh.geometry.index;
    const total=index?.count||position.count;
    for(let i=0;i<total;i++) {
      point.fromBufferAttribute(position,index?index.getX(i):i).applyMatrix4(mesh.matrixWorld);
      result[offset++]=point.x;result[offset++]=point.y;result[offset++]=point.z;
    }
  });
  return result;
}

export function analyze(object,{fingerprint=false,signal,onProgress}={}) {
  if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  const packed=packedTriangles(object);
  return new Promise((resolve,reject)=>{
    const worker=new Worker('/analysis-worker.js');
    const abort=()=>{worker.terminate();reject(new DOMException('Cancelled','AbortError'))};
    signal?.addEventListener('abort',abort,{once:true});
    const finish=()=>{worker.terminate();signal?.removeEventListener('abort',abort)};
    worker.onmessage=event=>{
      if(event.data.progress!==undefined)onProgress?.(event.data.progress);
      else {finish();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result)};
    };
    worker.onerror=event=>{finish();reject(new Error(event.message||'Geometry analysis failed'))};
    worker.postMessage({buffer:packed.buffer,fingerprint},[packed.buffer]);
  });
}
