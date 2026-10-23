import { defineConfig, presetWind3 } from "unocss";

export default defineConfig({
  presets: [presetWind3()],
  shortcuts: {
    "row-between": "flex items-center justify-between gap-3",
    eyebrow: "uppercase tracking-[0.18em] text-[10px] font-bold",
    mono: "font-mono tabular-nums",
    muted: "text-[#99a99c]",
  },
});
