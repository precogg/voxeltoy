/** Corner occlusion on a cell face, ordered (0,0), (1,0), (1,1), (0,1). */
export function faceOcclusion(cell: readonly number[], normal: readonly number[], u: readonly number[], v: readonly number[], solid: (x: number, y: number, z: number) => boolean): number[] {
  const shades = [1, 0.87, 0.77, 0.66];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const at = (du: number, dv: number) => solid(
      cell[0] + normal[0] + du * u[0] + dv * v[0],
      cell[1] + normal[1] + du * u[1] + dv * v[1],
      cell[2] + normal[2] + du * u[2] + dv * v[2]);
    const s1 = +at(a, 0), s2 = +at(0, b);
    return shades[s1 && s2 ? 3 : s1 + s2 + +at(a, b)];
  });
}
