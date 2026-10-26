// Pack each piece's own XY footprint; a large multi-plate file must not size
// every cell in the layout. Inputs and output use project millimetres.
export function compactPlacements(bounds) {
  if (!bounds.length) return [];
  const footprints = bounds.map((box, index) => ({index,
    width: Math.max(box.max[0] - box.min[0], .01),
    depth: Math.max(box.max[1] - box.min[1], .01)}));
  const typical = footprints.map(p => Math.min(p.width, p.depth)).sort((a,b) => a-b);
  const gap = Math.max(typical[Math.floor(typical.length / 2)] * .12, .1);
  const ordered = [...footprints].sort((a,b) => b.depth-a.depth || b.width-a.width || a.index-b.index);
  const maxWidth = Math.max(...ordered.map(p => p.width));
  const area = ordered.reduce((sum,p) => sum + (p.width+gap)*(p.depth+gap), 0);
  let best;
  for (const factor of [.8, 1, 1.2, 1.5, 2]) {
    const target = Math.max(maxWidth, Math.sqrt(area)*factor);
    let x=0,y=0,rowDepth=0,width=0;
    const positions=[];
    for (const piece of ordered) {
      if (x && x+piece.width > target) { x=0; y+=rowDepth+gap; rowDepth=0; }
      positions[piece.index]=[x,y];
      width=Math.max(width,x+piece.width);rowDepth=Math.max(rowDepth,piece.depth);
      x+=piece.width+gap;
    }
    const depth=y+rowDepth, score=Math.hypot(width,depth);
    if (!best || score<best.score) best={positions,width,depth,score};
  }
  return bounds.map((box,index) => [
    best.positions[index][0]-best.width/2-box.min[0],
    best.positions[index][1]-best.depth/2-box.min[1],
    -box.min[2]
  ]);
}
