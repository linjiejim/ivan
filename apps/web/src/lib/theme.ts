/**
 * 主题偏好：浅色 / 深色 / 跟随系统（默认）。手动选过的记在本机，启动时就套上（main.tsx），避免闪一下。
 * 同时把浏览器地址栏的 theme-color 对齐到当前纸色。
 */
import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

const KEY = "ivan.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
/** 与 styles.css 的 --page 一致 */
const PAGE = { light: "#f5f5f2", dark: "#0e0e0d" };

export function readThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function resolved(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.prepend(meta);
  }
  meta.content = PAGE[resolved(pref)];
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const on = () => {
      setSystemDark(mq.matches);
      if (readThemePref() === "system") applyTheme("system");
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const set = (next: ThemePref) => {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    applyTheme(next);
    setPref(next);
  };
  const dark = pref === "system" ? systemDark : pref === "dark";
  return { pref, set, dark };
}
