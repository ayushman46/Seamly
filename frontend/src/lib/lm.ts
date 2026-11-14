/**
 * A small Levenberg-Marquardt least-squares solver with a numeric Jacobian, for the camera fit (lib/camcal.ts) and the
 * ball-flight fit (lib/balltrack.ts). Problems here are tiny (7 to 11 unknowns, under a hundred residuals).
 */

/** Solve A x = b for a small dense system (Gauss with partial pivoting). Returns null when singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Inverse of a small symmetric positive matrix (column by column). Null when singular. */
export function invert(A: number[][]): number[][] | null {
  const n = A.length, cols: number[][] = [];
  for (let c = 0; c < n; c++) {
    const e = new Array<number>(n).fill(0); e[c] = 1;
    const x = solve(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return cols[0].map((_, r) => cols.map((col) => col[r]));
}

export interface Fit {
  x: number[];
  cost: number;            // sum of squared residuals
  residuals: number[];
  iterations: number;
  /** J'J at the answer (residuals are expected in units of their own sigma, so its inverse is the covariance). */
  normal: number[][];
}

export const sumSq = (r: number[]) => { let s = 0; for (const v of r) s += v * v; return s; };

export function jacobian(f: (x: number[]) => number[], x: number[], r0: number[], steps: number[]): number[][] {
  const J: number[][] = r0.map(() => new Array<number>(x.length).fill(0));
  for (let j = 0; j < x.length; j++) {
    const h = steps[j], xp = x.slice(), xm = x.slice();
    xp[j] += h; xm[j] -= h;
    const rp = f(xp), rm = f(xm);
    for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}

/**
 * Minimise sum(f(x)^2). `steps` are the finite-difference steps per unknown (about a thousandth of how far each one
 * can sensibly move).
 */
export function levenbergMarquardt(f: (x: number[]) => number[], x0: number[], steps: number[], maxIter = 60): Fit {
  let x = x0.slice(), r = f(x), cost = sumSq(r), lambda = 1e-3, it = 0;
  const n = x.length;
  let JtJ: number[][] = [];
  for (; it < maxIter; it++) {
    const J = jacobian(f, x, r, steps);
    JtJ = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < r.length; i++) {
      const Ji = J[i], ri = r[i];
      for (let a = 0; a < n; a++) {
        g[a] += Ji[a] * ri;
        for (let b = a; b < n; b++) JtJ[a][b] += Ji[a] * Ji[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];
    let better = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const dx = solve(A, g.map((v) => -v));
      if (dx) {
        const xn = x.map((v, a) => v + dx[a]), rn = f(xn), cn = sumSq(rn);
        if (Number.isFinite(cn) && cn < cost) {
          const gain = (cost - cn) / Math.max(cost, 1e-300);
          x = xn; r = rn; cost = cn; lambda = Math.max(lambda / 4, 1e-9); better = true;
          if (gain < 1e-10) it = maxIter;
          break;
        }
      }
      lambda *= 6;
    }
    if (!better) break;
  }
  return { x, cost, residuals: r, iterations: it, normal: JtJ };
}
