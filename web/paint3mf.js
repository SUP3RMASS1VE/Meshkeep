/* Slicer facet painting: hexadecimal nibbles are stored in reverse order.
   Nodes encode an edge split; leaves select a 1-based filament (0 inherits).
   See docs/3mf-colours.md for the format and interoperability references. */
export function decodePaint(text) {
  if (!text || !/^[0-9a-f]+$/i.test(text) || text.length > 1000000) throw new Error('Invalid 3MF paint data.');
  let cursor = text.length - 1;
  const nibble = () => {
    if (cursor < 0) throw new Error('Truncated 3MF paint data.');
    return parseInt(text[cursor--], 16);
  };
  function node(depth) {
    if (depth > 64) throw new Error('3MF paint tree is too deep.');
    const code = nibble(), split = code & 3, side = code >> 2;
    if (!split) {
      let state = side;
      if (state === 3) {
        let extra;
        do { extra = nibble(); state += extra; } while (extra === 15);
      }
      return {state, leaves: 1};
    }
    if (side > 2 || (split === 3 && side !== 0)) throw new Error('Invalid 3MF paint split.');
    const children = new Array(split + 1);
    let leaves = 0;
    for (let i = split; i >= 0; i--) { children[i] = node(depth + 1); leaves += children[i].leaves; }
    return {split, side, children, leaves};
  }
  const tree = node(0);
  if (cursor !== -1) throw new Error('Unexpected trailing 3MF paint data.');
  return tree;
}
const midpoint = (a, b) => a.map((v, i) => (v + b[i]) / 2);
export function paintedFacets(tree, vertices, emit) {
  if (!tree.split) { emit(vertices, tree.state); return; }
  const [a,b,c] = [0,1,2].map(i => vertices[(i + tree.side) % 3]);
  let pieces;
  if (tree.split === 1) {
    const m = midpoint(b,c); pieces = [[a,b,m],[m,c,a]];
  } else if (tree.split === 2) {
    const ab = midpoint(a,b), ca = midpoint(c,a); pieces = [[a,ab,ca],[ab,b,ca],[b,c,ca]];
  } else {
    const ab = midpoint(a,b), bc = midpoint(b,c), ca = midpoint(c,a);
    pieces = [[a,ab,ca],[ab,b,bc],[bc,c,ca],[ab,bc,ca]];
  }
  tree.children.forEach((child, i) => paintedFacets(child, pieces[i], emit));
}
