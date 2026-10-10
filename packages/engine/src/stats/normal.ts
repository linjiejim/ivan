/**
 * 标准正态分布（D65，PSR 用）：Φ 用 Cody 的 erfc 有理逼近（相对误差约 1e-16 量级，远小于 1e-9）；
 * Φ⁻¹ 用 Acklam 的有理逼近再做一步 Halley 修正。
 */

const A = [
  3.1611237438705655, 113.86415415105016, 377.485237685302, 3209.3775891384694, 0.18577770618460315,
];
const B = [23.601290952344122, 244.02463793444417, 1282.6165260773723, 2844.236833439171];
const C = [
  0.5641884969886701, 8.883149794388377, 66.11919063714163, 298.6351381974001, 881.952221241769,
  1712.0476126340707, 2051.0783778260716, 1230.3393547979972, 2.1531153547440383e-8,
];
const D = [
  15.744926110709835, 117.6939508913125, 537.1811018620099, 1621.3895745666903, 3290.7992357334597,
  4362.619090143247, 3439.3676741437216, 1230.3393548037495,
];
const P = [
  0.30532663496123236, 0.36034489994980445, 0.12578172611122926, 0.016083785148742275,
  6.587491615298378e-4, 0.016315387137302097,
];
const Q = [
  2.568520192289822, 1.8729528499234604, 0.5279051029514285, 0.06051834131244132,
  0.0023352049762686918,
];
const SQRPI = 0.5641895835477563; // 1 / √π

/** exp(−y²)，把 y² 拆成两段算，减小大 y 时的舍入误差 */
function expNegSq(y: number): number {
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  return Math.exp(-ysq * ysq) * Math.exp(-del);
}

/** 余误差函数 erfc(x)（W. J. Cody 1969） */
export function erfc(x: number): number {
  const y = Math.abs(x);
  let r: number;
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let num = A[4]! * ysq;
    let den = ysq;
    for (let i = 0; i < 3; i++) {
      num = (num + A[i]!) * ysq;
      den = (den + B[i]!) * ysq;
    }
    return 1 - (x * (num + A[3]!)) / (den + B[3]!);
  }
  if (y <= 4) {
    let num = C[8]! * y;
    let den = y;
    for (let i = 0; i < 7; i++) {
      num = (num + C[i]!) * y;
      den = (den + D[i]!) * y;
    }
    r = expNegSq(y) * ((num + C[7]!) / (den + D[7]!));
  } else if (y < 26.64) {
    const ysq = 1 / (y * y);
    let num = P[5]! * ysq;
    let den = ysq;
    for (let i = 0; i < 4; i++) {
      num = (num + P[i]!) * ysq;
      den = (den + Q[i]!) * ysq;
    }
    r = (ysq * (num + P[4]!)) / (den + Q[4]!);
    r = expNegSq(y) * ((SQRPI - r) / y);
  } else {
    r = 0;
  }
  return x < 0 ? 2 - r : r;
}

/** 标准正态分布函数 Φ(x) */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return 0.5 * erfc(-x / Math.SQRT2);
}

const IA = [
  -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
  2.506628277459239,
];
const IB = [
  -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
];
const IC = [
  -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const ID = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/** 标准正态分位数 Φ⁻¹(p)；p 必须在 (0, 1) 内 */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv 的 p 要在 (0, 1) 内：${p}`);
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((IC[0]! * q + IC[1]!) * q + IC[2]!) * q + IC[3]!) * q + IC[4]!) * q + IC[5]!) /
      ((((ID[0]! * q + ID[1]!) * q + ID[2]!) * q + ID[3]!) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((IA[0]! * r + IA[1]!) * r + IA[2]!) * r + IA[3]!) * r + IA[4]!) * r + IA[5]!) * q) /
      (((((IB[0]! * r + IB[1]!) * r + IB[2]!) * r + IB[3]!) * r + IB[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((IC[0]! * q + IC[1]!) * q + IC[2]!) * q + IC[3]!) * q + IC[4]!) * q + IC[5]!) /
      ((((ID[0]! * q + ID[1]!) * q + ID[2]!) * q + ID[3]!) * q + 1);
  }
  // 一步 Halley 修正
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
