/**
 * 对话里的计算器（spec 20261020 D105）：模型要做的换算、相减、算金额、年化都交给它，
 * 结果进数字核对的证据（模型自己心算的数核对不上会被标出来）。
 *
 * 只认四则运算、乘方、括号、数字（可带 % / 万 / 亿 后缀，可写科学计数法）和白名单函数；不 eval、不认变量。
 */

/** 单位：结果怎么显示、数字核对按什么归类。% 表示「结果是比例，显示成百分数」（0.23 → 23%） */
export const CALC_UNITS = ["%", "元", "港元", "亿", "万", "x", "天", "年", ""] as const;
export type CalcUnit = (typeof CALC_UNITS)[number];

const MAX_LEN = 300;
const MAX_DEPTH = 40;

type Fn = { min: number; max: number; f: (...a: number[]) => number };

const FUNCS = new Map<string, Fn>(
  Object.entries({
    abs: { min: 1, max: 1, f: Math.abs },
    sqrt: { min: 1, max: 1, f: Math.sqrt },
    ln: { min: 1, max: 1, f: Math.log },
    log10: { min: 1, max: 1, f: Math.log10 },
    exp: { min: 1, max: 1, f: Math.exp },
    pow: { min: 2, max: 2, f: Math.pow },
    min: { min: 1, max: 20, f: Math.min },
    max: { min: 1, max: 20, f: Math.max },
    round: {
      min: 1,
      max: 2,
      f: (x, d = 0) => {
        const k = 10 ** Math.trunc(d);
        return Math.round(x * k) / k;
      },
    },
    /** 年化收益：起点值、终点值、年数 → (end / start)^(1 / years) − 1 */
    cagr: { min: 3, max: 3, f: (start, end, years) => (end / start) ** (1 / years) - 1 },
    /** 把区间收益按自然日年化：(1 + ret)^(365 / days) − 1 */
    annualize: { min: 2, max: 2, f: (ret, days) => (1 + ret) ** (365 / days) - 1 },
    /** 涨跌幅：from → to 的变化比例 */
    change: { min: 2, max: 2, f: (from, to) => to / from - 1 },
  } satisfies Record<string, Fn>),
);

export const CALC_FUNCTIONS = [...FUNCS.keys()];

class CalcError extends Error {}

/** 计算一个表达式；不合法或结果不是有限数时抛 CalcError（中文原因） */
export function evaluate(expr: string): number {
  const src = expr
    .replace(/[×＊]/g, "*")
    .replace(/[÷／]/g, "/")
    .replace(/[－−]/g, "-")
    .replace(/＋/g, "+")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/，/g, ",")
    .replace(/％/g, "%");
  if (!src.trim()) throw new CalcError("表达式是空的");
  if (src.length > MAX_LEN) throw new CalcError(`表达式太长（最多 ${MAX_LEN} 个字符）`);
  let i = 0;
  let depth = 0;
  const peek = () => {
    while (src[i] === " ") i++;
    return src[i];
  };
  const expect = (ch: string) => {
    if (peek() !== ch) throw new CalcError(`第 ${i + 1} 个字符附近缺少「${ch}」`);
    i++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new CalcError("括号嵌套太深");
  };

  function expression(): number {
    enter();
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") {
        i++;
        v += term();
      } else if (c === "-") {
        i++;
        v -= term();
      } else break;
    }
    depth--;
    return v;
  }
  function term(): number {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === "*") {
        i++;
        v *= unary();
      } else if (c === "/") {
        i++;
        const d = unary();
        if (d === 0) throw new CalcError("除数是 0");
        v /= d;
      } else break;
    }
    return v;
  }
  /** 负号比乘方松：-2^2 = -(2^2)；指数里可以再带负号（2^-1），乘方右结合（2^3^2 = 2^9） */
  function unary(): number {
    const c = peek();
    if (c === "-") {
      i++;
      return -unary();
    }
    if (c === "+") {
      i++;
      return unary();
    }
    return power();
  }
  function power(): number {
    const base = primary();
    if (peek() === "^") {
      i++;
      return base ** unary();
    }
    return base;
  }
  function primary(): number {
    const c = peek();
    if (c === "(") {
      i++;
      const v = expression();
      expect(")");
      return suffix(v);
    }
    if (c !== undefined && /[0-9.]/.test(c)) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new CalcError(`第 ${i + 1} 个字符附近的数字写法不对`);
      i += m[0].length;
      return suffix(Number(m[0]));
    }
    if (c !== undefined && /[a-z]/i.test(c)) {
      const m = /^[a-z][a-z0-9_]*/i.exec(src.slice(i))!;
      const name = m[0].toLowerCase();
      i += m[0].length;
      // Map 而不是对象：constructor、__proto__ 这类名字查不到原型链上的东西
      const fn = FUNCS.get(name);
      if (!fn) throw new CalcError(`不认识的函数「${m[0]}」，可用：${CALC_FUNCTIONS.join("、")}`);
      expect("(");
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(expression());
        while (peek() === ",") {
          i++;
          args.push(expression());
        }
      }
      expect(")");
      if (args.length < fn.min || args.length > fn.max)
        throw new CalcError(
          `${name} 要 ${fn.min === fn.max ? fn.min : `${fn.min}–${fn.max}`} 个参数`,
        );
      return suffix(fn.f(...args));
    }
    throw new CalcError(c === undefined ? "表达式不完整" : `第 ${i + 1} 个字符「${c}」看不懂`);
  }
  /** 数字后缀：% = ÷100，万 = ×1e4，亿 = ×1e8（可以叠：3.5万亿） */
  function suffix(v: number): number {
    for (;;) {
      const c = peek();
      if (c === "%") {
        i++;
        v /= 100;
      } else if (c === "万") {
        i++;
        v *= 1e4;
      } else if (c === "亿") {
        i++;
        v *= 1e8;
      } else return v;
    }
  }

  const v = expression();
  if (peek() !== undefined) throw new CalcError(`第 ${i + 1} 个字符「${src[i]}」多余`);
  if (!Number.isFinite(v)) throw new CalcError("结果不是有限的数（比如负数开方、除以 0）");
  return v;
}

export interface CalcItem {
  label: string;
  expr: string;
  unit: CalcUnit;
  /** 显示用的数：unit 为 % 时已乘 100；出错为 null */
  value: number | null;
  error?: string;
}

/** 去掉浮点尾巴（0.1 + 0.2 → 0.3），保留 12 位有效数字 */
function clean(x: number): number {
  return Number(x.toPrecision(12));
}

export function calculate(
  items: ReadonlyArray<{ label: string; expr: string; unit?: CalcUnit | null }>,
): CalcItem[] {
  return items.map((it) => {
    const unit = it.unit ?? "";
    try {
      const v = evaluate(it.expr);
      return { label: it.label, expr: it.expr, unit, value: clean(unit === "%" ? v * 100 : v) };
    } catch (e) {
      if (!(e instanceof CalcError)) throw e;
      return { label: it.label, expr: it.expr, unit, value: null, error: e.message };
    }
  });
}
