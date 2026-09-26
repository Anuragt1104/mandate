"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Choice = "light" | "dark" | "system";

/** Light / Dark / System, remembered in this browser. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("mandate.theme");
      if (t === "light" || t === "dark") setChoice(t);
    } catch {
      /* default */
    }
  }, []);
  const pick = (c: Choice) => {
    setChoice(c);
    const root = document.documentElement;
    if (c === "system") delete root.dataset.theme;
    else root.dataset.theme = c;
    try {
      if (c === "system") localStorage.removeItem("mandate.theme");
      else localStorage.setItem("mandate.theme", c);
    } catch {
      /* not remembered */
    }
  };
  const opts: [Choice, typeof Sun, string][] = [["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "System"]];
  return (
    <div className="segmented theme-toggle" role="group" aria-label="Theme">
      {opts.map(([c, Icon, label]) => (
        <button key={c} aria-pressed={choice === c} onClick={() => pick(c)} title={label} aria-label={label}>
          <Icon style={{ width: 14, height: 14 }} />
        </button>
      ))}
    </div>
  );
}
