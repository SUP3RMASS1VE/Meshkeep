/* Geometry analysis runs outside the UI thread. Fingerprints normalise translation,
   face order and winding, and compare coordinates to 0.001 mm precision. */
self.onmessage = async event => {
  try {
    const {buffer, fingerprint = false} = event.data;
    const points = new Float32Array(buffer), count = points.length / 9;
    const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    for (let i=0;i<points.length;i++) {
      const axis=i%3, value=points[i];
      if (!Number.isFinite(value)) throw new Error('Geometry contains invalid coordinates.');
      min[axis]=Math.min(min[axis],value); max[axis]=Math.max(max[axis],value);
    }
    const dimensions=max.map((n,i)=>n-min[i]);
    const hashA=fingerprint ? new BigUint64Array(count) : null;
    const hashB=fingerprint ? new BigUint64Array(count) : null;
    // Edge balance is bounded; enormous meshes still receive dimensions and an
    // estimate, but are not described as verified watertight.
    const edges=count<=250000 ? new Map() : null;
    let signedVolume=0;
    const q = (value,axis) => Math.round((value-min[axis])*1000);
    const compare=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
    for(let triangle=0;triangle<count;triangle++) {
      const i=triangle*9;
      const a=[points[i]-min[0],points[i+1]-min[1],points[i+2]-min[2]];
      const b=[points[i+3]-min[0],points[i+4]-min[1],points[i+5]-min[2]];
      const c=[points[i+6]-min[0],points[i+7]-min[1],points[i+8]-min[2]];
      signedVolume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
      if(fingerprint || edges) {
        const vertices=[0,3,6].map(offset=>[0,1,2].map(axis=>q(points[i+offset+axis],axis)));
        if(vertices.some(v=>v.some(n=>n>2147483647))) throw new Error('Model is too large for geometry comparison at 0.001 mm precision.');
        if(edges) for(let j=0;j<3;j++) {
          const first=vertices[j],second=vertices[(j+1)%3],direction=compare(first,second);
          if(!direction) continue;
          const key=(direction<0 ? [first,second] : [second,first]).map(v=>v.join(',')).join('|');
          const value=edges.get(key)||[0,0]; value[0]++;value[1]+=direction<0?1:-1;edges.set(key,value);
        }
        if(fingerprint) {
          vertices.sort(compare);
          let h1=2166136261,h2=2246822519,h3=3266489917,h4=668265263;
          for(const vertex of vertices) for(const n of vertex) {
            h1=Math.imul(h1^n,16777619)>>>0;
            h2=Math.imul(h2^n,3266489917)>>>0;h2^=h2>>>13;
            h3=Math.imul(h3^n,668265263)>>>0;h3^=h3>>>15;
            h4=Math.imul(h4^n,374761393)>>>0;h4^=h4>>>11;
          }
          hashA[triangle]=(BigInt(h1>>>0)<<32n)|BigInt(h2>>>0);
          hashB[triangle]=(BigInt(h3>>>0)<<32n)|BigInt(h4>>>0);
        }
      }
      if(triangle%100000===0) self.postMessage({progress:triangle/count});
    }
    let digest=null;
    if(fingerprint) {
      hashA.sort();hashB.sort();
      const combined=new Uint8Array(hashA.byteLength+hashB.byteLength+8);
      new DataView(combined.buffer).setBigUint64(0,BigInt(count),true);
      combined.set(new Uint8Array(hashA.buffer),8);combined.set(new Uint8Array(hashB.buffer),8+hashA.byteLength);
      digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',combined))).map(n=>n.toString(16).padStart(2,'0')).join('');
    }
    const closed=!!edges && edges.size>0 && Array.from(edges.values()).every(([count,balance])=>count===2&&balance===0);
    self.postMessage({result:{fingerprint:digest,triangles:count,dimensions:[dimensions[0],dimensions[2],dimensions[1]],volume:Math.abs(signedVolume),closed}});
  } catch(error) { self.postMessage({error:error.message}); }
};
