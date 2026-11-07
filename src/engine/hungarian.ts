/**
 * Minimum-cost assignment on a rectangular matrix (Kuhn-Munkres with potentials), O(n^2 m).
 * Every row gets a column when rows <= columns; otherwise the cheapest set of rows does.
 * Returns the column for each row, or -1. Cells at or above FORBIDDEN are never matched.
 */
export const FORBIDDEN = 1e9

export function hungarian(cost: number[][]): number[] {
  const rows = cost.length
  const cols = rows ? cost[0].length : 0
  if (!rows || !cols) return new Array(rows).fill(-1)
  if (rows > cols) {
    const flipped: number[][] = Array.from({ length: cols }, (_, c) => cost.map(r => r[c]))
    const byCol = hungarian(flipped)
    const out = new Array<number>(rows).fill(-1)
    byCol.forEach((r, c) => { if (r >= 0) out[r] = c })
    return out
  }
  const u = new Float64Array(rows + 1)
  const v = new Float64Array(cols + 1)
  const match = new Int32Array(cols + 1)
  const way = new Int32Array(cols + 1)
  const minv = new Float64Array(cols + 1)
  const used = new Uint8Array(cols + 1)
  for (let i = 1; i <= rows; i++) {
    match[0] = i
    let j0 = 0
    minv.fill(Infinity)
    used.fill(0)
    do {
      used[j0] = 1
      const i0 = match[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue
        const reduced = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (reduced < minv[j]) { minv[j] = reduced; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) { u[match[j]] += delta; v[j] -= delta } else minv[j] -= delta
      }
      j0 = j1
    } while (match[j0] !== 0)
    do {
      const j1 = way[j0]
      match[j0] = match[j1]
      j0 = j1
    } while (j0)
  }
  const out = new Array<number>(rows).fill(-1)
  for (let j = 1; j <= cols; j++) {
    if (match[j] && cost[match[j] - 1][j - 1] < FORBIDDEN) out[match[j] - 1] = j - 1
  }
  return out
}
