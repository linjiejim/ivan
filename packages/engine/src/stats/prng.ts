/**
 * 可复现的伪随机数（D65）：mulberry32，32 位状态，同一个种子永远给出同一串数。
 * 自助法的种子来自输入指纹，所以同样的输入（第二天在没变的数据上重跑也一样）得到同样的区间。
 */

/** 返回 [0, 1) 上的均匀分布 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
