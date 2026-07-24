import {
  EVE_DEV_TRACES_DATA_ROUTE_PATH,
  EVE_DEV_TRACES_ROUTE_PATH,
  EVE_DEV_TRACES_STREAM_ROUTE_PATH,
} from "#protocol/routes.js";

/**
 * The self-contained local trace viewer SPA served at `GET /__traces`.
 *
 * A single HTML document with inline CSS and vanilla JS — no external assets,
 * no bundler, no CDN — so it can be served as a string by the dev-only control
 * handler. Its palette, radii, and font stacks mirror the repo's shadcn
 * "new-york" design system (see `apps/templates/web-chat-next/app/globals.css`)
 * so the viewer looks like it belongs to eve.
 */
export const TRACE_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>eve · traces</title>
<style>
  :root {
    color-scheme: light;
    --background: oklch(0.971 0 0);
    --foreground: oklch(0.16 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.16 0 0);
    --primary: oklch(0.19 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.94 0 0);
    --secondary-foreground: oklch(0.19 0 0);
    --muted: oklch(0.94 0 0);
    --muted-foreground: oklch(0.6 0 0);
    --accent: oklch(0.94 0 0);
    --accent-foreground: oklch(0.19 0 0);
    --border: oklch(0.916 0 0);
    --radius: 0.625rem;
    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "Geist Mono", "Geist Mono Fallback", ui-monospace, monospace;
    --kind-turn: oklch(0.55 0.15 255);
    --kind-step: oklch(0.62 0.02 260);
    --kind-model-call: oklch(0.56 0.17 300);
    --kind-tool: oklch(0.6 0.14 165);
    --kind-subagent: oklch(0.68 0.15 65);
    --gridline: oklch(0.9 0 0);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --background: oklch(0.145 0 0);
      --foreground: oklch(0.985 0 0);
      --card: oklch(0.205 0 0);
      --card-foreground: oklch(0.985 0 0);
      --primary: oklch(0.922 0 0);
      --primary-foreground: oklch(0.205 0 0);
      --secondary: oklch(0.269 0 0);
      --secondary-foreground: oklch(0.985 0 0);
      --muted: oklch(0.269 0 0);
      --muted-foreground: oklch(0.708 0 0);
      --accent: oklch(0.269 0 0);
      --accent-foreground: oklch(0.985 0 0);
      --border: oklch(1 0 0 / 12%);
      --kind-turn: oklch(0.65 0.15 255);
      --kind-step: oklch(0.7 0.02 260);
      --kind-model-call: oklch(0.68 0.16 300);
      --kind-tool: oklch(0.72 0.14 165);
      --kind-subagent: oklch(0.78 0.14 65);
      --gridline: oklch(1 0 0 / 8%);
    }
  }
  * { box-sizing: border-box; border-color: var(--border); }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--background);
    color: var(--foreground);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .mono { font-family: var(--font-mono); font-feature-settings: "zero"; }
  .app {
    display: grid;
    grid-template-columns: minmax(280px, 340px) 1fr;
    height: 100vh;
  }
  .sidebar {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--background);
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }
  .title { font-size: 0.9375rem; font-weight: 600; letter-spacing: -0.01em; }
  .title small { color: var(--muted-foreground); font-weight: 400; }
  .runs { overflow-y: auto; padding: 0.5rem; flex: 1; min-height: 0; }
  .run {
    width: 100%;
    text-align: left;
    background: var(--card);
    color: var(--card-foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.875rem;
    margin-bottom: 0.5rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .run:hover { border-color: var(--muted-foreground); }
  .run.selected { border-color: var(--foreground); background: var(--accent); }
  .run-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .run-name { font-weight: 500; font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta { display: flex; flex-wrap: wrap; gap: 0.375rem 0.75rem; color: var(--muted-foreground); font-size: 0.75rem; }
  .run-meta .mono { color: var(--foreground); }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.4375rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
  }
  .badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .detail { overflow-y: auto; min-height: 0; padding: 1.5rem 1.75rem; }
  .detail-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
  .detail-title { font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em; }
  .detail-sub { color: var(--muted-foreground); font-size: 0.75rem; margin-top: 0.25rem; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .kpi {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.875rem;
  }
  .kpi-label { color: var(--muted-foreground); font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-value { font-size: 1.25rem; font-weight: 600; margin-top: 0.25rem; letter-spacing: -0.01em; }
  .kpi-value small { font-size: 0.75rem; font-weight: 400; color: var(--muted-foreground); }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .card-head { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.8125rem; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
  .legend { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .legend-item { display: inline-flex; align-items: center; gap: 0.3125rem; color: var(--muted-foreground); font-size: 0.6875rem; font-weight: 400; }
  .legend-swatch { width: 10px; height: 10px; border-radius: 3px; }
  /* geist --ds-* design tokens (ported from @vercel/geist) so the tree styling
     below matches @vercel/trace-viewer exactly. Light in :root; dark applied via
     prefers-color-scheme and the [data-theme] overrides. */
  :root {
    --ds-gray-100: hsl(0 0% 95%); --ds-gray-200: hsl(0 0% 92%); --ds-gray-300: hsl(0 0% 90%);
    --ds-gray-400: hsl(0 0% 92%); --ds-gray-500: hsl(0 0% 79%); --ds-gray-800: hsl(0 0% 49%);
    --ds-gray-900: hsl(0 0% 30%); --ds-gray-1000: hsl(0 0% 9%);
    --ds-gray-alpha-200: hsla(0, 0%, 0%, 0.081); --ds-gray-alpha-300: hsla(0, 0%, 0%, 0.1);
    --ds-background-100: hsl(0 0% 100%);
    --ds-teal-200: hsl(167 70% 94%); --ds-teal-400: hsl(170 70% 85%); --ds-teal-500: hsl(170 70% 72%); --ds-teal-900: hsl(174 91% 25%);
    --ds-blue-200: hsl(210 100% 96%); --ds-blue-400: hsl(209 100% 90%); --ds-blue-500: hsl(209 100% 80%); --ds-blue-900: hsl(211 100% 42%);
    --ds-green-200: hsl(120 60% 95%); --ds-green-400: hsl(122 60% 86%); --ds-green-500: hsl(124 60% 75%); --ds-green-900: hsl(133 50% 32%);
    --ds-purple-200: hsl(277 87% 97%); --ds-purple-400: hsl(276 71% 92%); --ds-purple-500: hsl(274 70% 82%); --ds-purple-900: hsl(274 71% 43%);
    --ds-pink-200: hsl(340 90% 96%); --ds-pink-400: hsl(341 76% 91%); --ds-pink-500: hsl(340 75% 84%); --ds-pink-900: hsl(336 65% 45%);
    --ds-amber-200: hsl(44 100% 92%); --ds-amber-400: hsl(42 100% 78%); --ds-amber-500: hsl(38 100% 71%); --ds-amber-900: hsl(30 100% 32%);
    --ds-red-200: hsl(0 100% 96%); --ds-red-400: hsl(0 90% 92%); --ds-red-500: hsl(0 82% 85%); --ds-red-900: hsl(358 66% 48%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ds-gray-100: hsl(0 0% 10%); --ds-gray-200: hsl(0 0% 12%); --ds-gray-300: hsl(0 0% 16%);
      --ds-gray-400: hsl(0 0% 18%); --ds-gray-500: hsl(0 0% 27%); --ds-gray-800: hsl(0 0% 49%);
      --ds-gray-900: hsl(0 0% 63%); --ds-gray-1000: hsl(0 0% 93%);
      --ds-gray-alpha-200: hsla(0, 0%, 100%, 0.09); --ds-gray-alpha-300: hsla(0, 0%, 100%, 0.13);
      --ds-background-100: hsl(0 0% 4%);
      --ds-teal-200: hsl(170 74% 9%); --ds-teal-400: hsl(171 85% 13%); --ds-teal-500: hsl(172 85% 20%); --ds-teal-900: hsl(174 90% 41%);
      --ds-blue-200: hsl(214 59% 15%); --ds-blue-400: hsl(212 78% 23%); --ds-blue-500: hsl(211 86% 27%); --ds-blue-900: hsl(210 100% 66%);
      --ds-green-200: hsl(137 50% 12%); --ds-green-400: hsl(135 70% 16%); --ds-green-500: hsl(135 70% 23%); --ds-green-900: hsl(131 43% 57%);
      --ds-purple-200: hsl(281 38% 16%); --ds-purple-400: hsl(277 46% 28%); --ds-purple-500: hsl(274 49% 35%); --ds-purple-900: hsl(275 80% 71%);
      --ds-pink-200: hsl(335 43% 16%); --ds-pink-400: hsl(335 51% 22%); --ds-pink-500: hsl(335 57% 27%); --ds-pink-900: hsl(341 90% 67%);
      --ds-amber-200: hsl(32 100% 10%); --ds-amber-400: hsl(35 100% 17%); --ds-amber-500: hsl(35 91% 22%); --ds-amber-900: hsl(39 90% 50%);
      --ds-red-200: hsl(357 46% 16%); --ds-red-400: hsl(357 55% 26%); --ds-red-500: hsl(357 60% 32%); --ds-red-900: hsl(358 100% 69%);
    }
  }
  :root[data-theme="dark"] {
    --ds-gray-100: hsl(0 0% 10%); --ds-gray-200: hsl(0 0% 12%); --ds-gray-300: hsl(0 0% 16%);
    --ds-gray-400: hsl(0 0% 18%); --ds-gray-500: hsl(0 0% 27%); --ds-gray-800: hsl(0 0% 49%);
    --ds-gray-900: hsl(0 0% 63%); --ds-gray-1000: hsl(0 0% 93%);
    --ds-gray-alpha-200: hsla(0, 0%, 100%, 0.09); --ds-gray-alpha-300: hsla(0, 0%, 100%, 0.13);
    --ds-background-100: hsl(0 0% 4%);
    --ds-teal-200: hsl(170 74% 9%); --ds-teal-400: hsl(171 85% 13%); --ds-teal-500: hsl(172 85% 20%); --ds-teal-900: hsl(174 90% 41%);
    --ds-blue-200: hsl(214 59% 15%); --ds-blue-400: hsl(212 78% 23%); --ds-blue-500: hsl(211 86% 27%); --ds-blue-900: hsl(210 100% 66%);
    --ds-green-200: hsl(137 50% 12%); --ds-green-400: hsl(135 70% 16%); --ds-green-500: hsl(135 70% 23%); --ds-green-900: hsl(131 43% 57%);
    --ds-purple-200: hsl(281 38% 16%); --ds-purple-400: hsl(277 46% 28%); --ds-purple-500: hsl(274 49% 35%); --ds-purple-900: hsl(275 80% 71%);
    --ds-pink-200: hsl(335 43% 16%); --ds-pink-400: hsl(335 51% 22%); --ds-pink-500: hsl(335 57% 27%); --ds-pink-900: hsl(341 90% 67%);
    --ds-amber-200: hsl(32 100% 10%); --ds-amber-400: hsl(35 100% 17%); --ds-amber-500: hsl(35 91% 22%); --ds-amber-900: hsl(39 90% 50%);
    --ds-red-200: hsl(357 46% 16%); --ds-red-400: hsl(357 55% 26%); --ds-red-500: hsl(357 60% 32%); --ds-red-900: hsl(358 100% 69%);
  }
  :root[data-theme="light"] {
    --ds-gray-100: hsl(0 0% 95%); --ds-gray-200: hsl(0 0% 92%); --ds-gray-300: hsl(0 0% 90%);
    --ds-gray-400: hsl(0 0% 92%); --ds-gray-500: hsl(0 0% 79%); --ds-gray-800: hsl(0 0% 49%);
    --ds-gray-900: hsl(0 0% 30%); --ds-gray-1000: hsl(0 0% 9%);
    --ds-gray-alpha-200: hsla(0, 0%, 0%, 0.081); --ds-gray-alpha-300: hsla(0, 0%, 0%, 0.1);
    --ds-background-100: hsl(0 0% 100%);
    --ds-teal-200: hsl(167 70% 94%); --ds-teal-400: hsl(170 70% 85%); --ds-teal-500: hsl(170 70% 72%); --ds-teal-900: hsl(174 91% 25%);
    --ds-blue-200: hsl(210 100% 96%); --ds-blue-400: hsl(209 100% 90%); --ds-blue-500: hsl(209 100% 80%); --ds-blue-900: hsl(211 100% 42%);
    --ds-green-200: hsl(120 60% 95%); --ds-green-400: hsl(122 60% 86%); --ds-green-500: hsl(124 60% 75%); --ds-green-900: hsl(133 50% 32%);
    --ds-purple-200: hsl(277 87% 97%); --ds-purple-400: hsl(276 71% 92%); --ds-purple-500: hsl(274 70% 82%); --ds-purple-900: hsl(274 71% 43%);
    --ds-pink-200: hsl(340 90% 96%); --ds-pink-400: hsl(341 76% 91%); --ds-pink-500: hsl(340 75% 84%); --ds-pink-900: hsl(336 65% 45%);
    --ds-amber-200: hsl(44 100% 92%); --ds-amber-400: hsl(42 100% 78%); --ds-amber-500: hsl(38 100% 71%); --ds-amber-900: hsl(30 100% 32%);
    --ds-red-200: hsl(0 100% 96%); --ds-red-400: hsl(0 90% 92%); --ds-red-500: hsl(0 82% 85%); --ds-red-900: hsl(358 66% 48%);
  }
  /* span color palette (resource-indexed) ported from trace-viewer.module.css */
  .color0 { --span-background: var(--ds-teal-200); --span-border: var(--ds-teal-500); --span-line: var(--ds-teal-400); --span-secondary: var(--ds-teal-900); }
  .color1 { --span-background: var(--ds-blue-200); --span-border: var(--ds-blue-500); --span-line: var(--ds-blue-400); --span-secondary: var(--ds-blue-900); }
  .color2 { --span-background: var(--ds-green-200); --span-border: var(--ds-green-500); --span-line: var(--ds-green-400); --span-secondary: var(--ds-green-900); }
  .color3 { --span-background: var(--ds-purple-200); --span-border: var(--ds-purple-500); --span-line: var(--ds-purple-400); --span-secondary: var(--ds-purple-900); }
  .color4 { --span-background: var(--ds-pink-200); --span-border: var(--ds-pink-500); --span-line: var(--ds-pink-400); --span-secondary: var(--ds-pink-900); }
  .colorVercel { --span-background: var(--ds-background-100); --span-border: var(--ds-gray-500); --span-line: var(--ds-gray-400); --span-secondary: var(--ds-gray-900); }
  .colorSuccess { --span-background: var(--ds-green-200); --span-border: var(--ds-green-500); --span-line: var(--ds-green-400); --span-secondary: var(--ds-green-900); }
  .colorError { --span-background: var(--ds-red-200); --span-border: var(--ds-red-500); --span-line: var(--ds-red-400); --span-secondary: var(--ds-red-900); }
  .colorHighlight { --span-background: var(--ds-amber-200); --span-border: var(--ds-amber-500); --span-line: var(--ds-amber-400); --span-secondary: var(--ds-amber-900); }

  .waterfall { padding: 0.5rem 0; position: relative; }
  .wf-row, .wf-axis {
    display: grid;
    grid-template-columns: minmax(200px, 320px) 1fr;
    align-items: center;
    gap: 0.75rem;
    padding: 0 1rem;
  }
  /* .treeRow */
  .wf-row { height: 32px; font-size: 13px; border-bottom: 1px solid var(--ds-gray-alpha-200); }
  .wf-row:hover { background: var(--ds-gray-100); }
  .wf-axis { padding-top: 0.25rem; padding-bottom: 0.25rem; margin-bottom: 0.125rem; }
  .wf-axis-track { position: relative; height: 1.5rem; overflow: hidden; border-bottom: 1px solid var(--ds-gray-alpha-200); }
  .wf-tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--ds-gray-alpha-300); padding-left: 4px; }
  .wf-tick-label { color: var(--ds-gray-900); font-size: 0.6875rem; white-space: nowrap; }
  /* .treeRowLeft + .treeSpanName */
  .wf-label { display: flex; align-items: center; gap: 4px; overflow: hidden; }
  .wf-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--ds-gray-1000); }
  /* .treeResourceDotInner */
  .wf-kind-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--span-border, var(--ds-gray-500)); }
  /* .treeTimingBarContainer */
  .wf-track { position: relative; height: 12px; overflow: hidden; }
  .wf-track::before { position: absolute; inset: 50% 1px; height: 1px; background: var(--ds-gray-alpha-300); content: ""; }
  .wf-track::after { position: absolute; inset: 0; border: 1px solid var(--ds-gray-alpha-300); border-top: none; border-bottom: none; content: ""; }
  /* .treeTimingBar (ticked bar) */
  .wf-bar {
    position: absolute;
    top: 0;
    height: 100%;
    min-width: 2px;
    border: 1px solid var(--span-border);
    border-radius: 2px;
    background:
      linear-gradient(180deg, transparent 0px, transparent 6px, var(--span-background) 6px, var(--span-background) 12px),
      var(--span-background) repeating-linear-gradient(90deg, transparent 0px, transparent 7px, var(--span-border) 7px, var(--span-border) 8px);
  }
  .wf-bar::before {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 8px;
    background: repeating-linear-gradient(90deg, var(--span-background) 0px, var(--span-background) 24px, transparent 24px, transparent 32px);
    content: "";
  }
  /* .treeSpanDuration */
  .wf-dur {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    color: var(--ds-gray-900);
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .wf-dur.dur-right { padding-left: 0.375rem; }
  .wf-dur.dur-left { padding-right: 0.375rem; }
  .empty { color: var(--ds-gray-900); text-align: center; padding: 3rem 1rem; font-size: 0.8125rem; }
  .legend-swatch { background: var(--span-border); }
  .wf-controls { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .live { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--muted-foreground); font-size: 0.6875rem; font-weight: 500; white-space: nowrap; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); flex-shrink: 0; }
  .live[data-state="off"] { opacity: 0.7; }
  .live[data-state="on"] .live-dot { background: var(--kind-tool); animation: live-pulse 1.6s ease-in-out infinite; }
  @keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  /* Running timeline: the window is [runStart, now] fit to the viewport, so
     every span is always visible. A requestAnimationFrame loop advances "now"
     each frame while the run is live, so the axis ticks forward and new labels
     appear; new spans fade in. The "now" edge is the right edge of the track. */
  @keyframes wf-row-enter { from { opacity: 0; } to { opacity: 1; } }
  .wf-row.wf-enter { animation: wf-row-enter 220ms ease-out both; }
  .wf-now { position: absolute; top: 2.25rem; bottom: 0.5rem; right: 1rem; width: 2px; border-radius: 2px; background: var(--kind-tool); opacity: 0; pointer-events: none; }
  .card.is-live .wf-now { opacity: 0.85; animation: now-pulse 1.6s ease-in-out infinite; }
  @keyframes now-pulse { 0%, 100% { opacity: 0.85; } 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) {
    .live[data-state="on"] .live-dot { animation: none; }
    .wf-row.wf-enter { animation: none; }
    .card.is-live .wf-now { animation: none; }
  }

  /* Span detail panel — a right-hand drawer opened by clicking a waterfall row.
     Structure and styling ported from @vercel/trace-viewer's span-detail-panel.
     The waterfall's bars/axis are percentage-based, so the main column reflowing
     to make room for the panel needs no JS relayout. */
  .wf-row { cursor: pointer; }
  .wf-row.selected { background: var(--ds-gray-100); box-shadow: inset 2px 0 0 var(--span-border); }
  .app.panel-open { grid-template-columns: minmax(280px, 340px) 1fr minmax(340px, 460px); }
  .span-panel { display: none; }
  .app.panel-open .span-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100vh;
    border-left: 1px solid var(--border);
    background: var(--background);
  }
  .span-panel-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 12px 16px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .span-panel-heading { display: flex; align-items: center; gap: 10px; overflow: hidden; }
  .span-panel-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--span-border, var(--ds-gray-500)); }
  .span-panel-dur { flex-shrink: 0; color: var(--ds-gray-900); font-size: 13px; font-variant-numeric: tabular-nums; }
  .span-panel-name { min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .span-panel-close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--ds-gray-900);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .span-panel-close:hover { background: var(--ds-gray-200); color: var(--ds-gray-1000); }
  .span-panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 32px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-size: 12px;
    white-space: nowrap;
  }
  .chip b { font-weight: 500; font-variant-numeric: tabular-nums; }
  .dg { display: flex; flex-direction: column; border-bottom: 1px solid var(--border); }
  .dg:last-child { border-bottom: none; }
  .dg-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 10px 8px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    color: var(--ds-gray-1000);
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .dg-head:hover { background: var(--ds-gray-100); }
  .dg-chevron { flex-shrink: 0; color: var(--ds-gray-900); font-size: 9px; transition: transform 0.12s ease; }
  .dg.collapsed .dg-chevron { transform: rotate(-90deg); }
  .dg.collapsed .dg-body { display: none; }
  .dg-body { display: flex; flex-direction: column; padding-bottom: 8px; }
  .dg.dg-error .dg-head { color: var(--ds-red-900); }
  .attr {
    margin: 0;
    padding: 7px 8px;
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    font-size: 13px;
    line-height: 1.4;
    border-bottom: 1px solid var(--ds-gray-alpha-200);
  }
  .attr:last-child { border-bottom: none; }
  .attr-key { flex: 0 0 auto; color: var(--ds-gray-900); }
  .attr-val { flex: 0 1 auto; min-width: 0; font-family: var(--font-mono); font-size: 12px; text-align: right; word-break: break-word; }
  .field { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
  .field-label { color: var(--ds-gray-900); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .code {
    margin: 0;
    max-height: 380px;
    overflow: auto;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--ds-gray-1000);
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--ds-gray-100);
    border: 1px solid var(--ds-gray-alpha-200);
    border-radius: 6px;
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="title">eve traces <small id="run-count"></small></div>
      <div class="live" id="live" data-state="off"><span class="live-dot"></span><span id="live-label">Connecting…</span></div>
    </div>
    <div class="runs" id="runs"></div>
  </aside>
  <main class="detail" id="detail">
    <div class="empty">Select a run to inspect its waterfall.</div>
  </main>
  <aside class="span-panel" id="span-panel"></aside>
</div>
<script>
(function () {
  "use strict";
  var DATA_PATH = ${JSON.stringify(EVE_DEV_TRACES_DATA_ROUTE_PATH)};
  var VIEWER_PATH = ${JSON.stringify(EVE_DEV_TRACES_ROUTE_PATH)};
  var STREAM_PATH = ${JSON.stringify(EVE_DEV_TRACES_STREAM_ROUTE_PATH)};
  // How recently a run's last span must have ended for the viewer to start
  // following it live. Once following, it keeps following regardless of idle.
  var FOLLOW_START_MS = 60000;
  var KINDS = ["turn", "step", "model-call", "tool", "subagent"];
  var KIND_LABELS = { turn: "Turn", step: "Step", "model-call": "Model", tool: "Tool", subagent: "Subagent" };

  var runsEl = document.getElementById("runs");
  var detailEl = document.getElementById("detail");
  var panelEl = document.getElementById("span-panel");
  var appEl = document.querySelector(".app");
  var countEl = document.getElementById("run-count");
  var liveEl = document.getElementById("live");
  var liveLabelEl = document.getElementById("live-label");

  // GenAI/AI-SDK attribute keys the detail panel reads, most-specific first.
  var INPUT_TOKEN_KEYS = ["gen_ai.usage.input_tokens", "ai.usage.inputTokens", "ai.usage.promptTokens"];
  var OUTPUT_TOKEN_KEYS = ["gen_ai.usage.output_tokens", "ai.usage.outputTokens", "ai.usage.completionTokens"];
  var CACHE_TOKEN_KEYS = ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cached_input_tokens", "ai.usage.cachedInputTokens"];
  var MODEL_KEYS = ["gen_ai.request.model", "gen_ai.response.model", "ai.model.id", "ai.response.model"];
  var FINISH_KEYS = ["gen_ai.response.finish_reasons", "ai.response.finishReason"];
  var SYSTEM_KEYS = ["gen_ai.system_instructions", "ai.prompt.system"];
  var INPUT_MSG_KEYS = ["gen_ai.input.messages", "ai.prompt.messages", "ai.prompt"];
  var OUTPUT_MSG_KEYS = ["gen_ai.output.messages", "ai.response.text", "ai.response.object"];
  var TOOL_NAME_KEYS = ["gen_ai.tool.name", "ai.toolCall.name"];
  var TOOL_ARGS_KEYS = ["gen_ai.tool.call.arguments", "ai.toolCall.args"];
  var TOOL_RESULT_KEYS = ["gen_ai.tool.call.result", "ai.toolCall.result"];
  var selectedId = null;
  var runsById = {};
  var newestRunId = null;
  var followingRunId = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function classifyKind(name) {
    var n = (name || "").toLowerCase();
    if (n === "ai.eve.session" || n === "ai.eve.turn" || n.indexOf(".turn") !== -1) return "turn";
    if (n.indexOf("dostream") !== -1 || n.indexOf("streamtext") !== -1 || n.indexOf("generatetext") !== -1 || n.indexOf("dogenerate") !== -1) return "model-call";
    if (n.indexOf("subagent") !== -1) return "subagent";
    if (n.indexOf("tool") !== -1) return "tool";
    if (n.indexOf("step") !== -1) return "step";
    return "step";
  }

  // Map each kind onto a trace-viewer span color class (the geist resource
  // palette): the row carries this class, and the timing bar / dot / duration
  // read --span-* from it.
  var KIND_COLOR = {
    turn: "color1",
    "model-call": "color3",
    tool: "color0",
    subagent: "color4",
    step: "colorVercel",
  };

  function colorClassFor(name) {
    return KIND_COLOR[classifyKind(name)] || "colorVercel";
  }

  function formatDuration(ms) {
    if (ms == null) return "-";
    if (ms < 1000) return Math.round(ms) + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
  }

  function formatTokens(n) {
    if (n == null) return "0";
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1) + "k";
  }

  function formatTime(ms) {
    if (!ms) return "";
    try { return new Date(ms).toLocaleTimeString(); } catch (e) { return ""; }
  }

  function renderRuns(runs) {
    countEl.textContent = runs.length ? "(" + runs.length + ")" : "";
    if (!runs.length) {
      runsEl.innerHTML = "";
      runsEl.appendChild(el("div", "empty", "No runs captured yet."));
      return;
    }
    var frag = document.createDocumentFragment();
    runs.forEach(function (run) {
      var card = el("button", "run" + (run.traceId === selectedId ? " selected" : ""));
      card.type = "button";
      card.dataset.traceId = run.traceId;

      var top = el("div", "run-top");
      top.appendChild(el("div", "run-name", run.rootName || run.traceId));
      var trigger = run.trigger || "unknown";
      var badge = el("span", "badge");
      badge.appendChild(el("span", "dot kind-" + classifyKind(run.rootName)));
      badge.appendChild(document.createTextNode(trigger));
      top.appendChild(badge);
      card.appendChild(top);

      var meta = el("div", "run-meta");
      meta.appendChild(metaPair("turns", String(run.turnCount)));
      meta.appendChild(metaPair("tokens", formatTokens(run.totalTokens)));
      meta.appendChild(metaPair("dur", formatDuration(run.durationMillis)));
      var t = formatTime(run.startedAtMillis);
      if (t) meta.appendChild(el("span", "", t));
      card.appendChild(meta);

      card.addEventListener("click", function () { selectRun(run.traceId); });
      frag.appendChild(card);
    });
    runsEl.innerHTML = "";
    runsEl.appendChild(frag);
  }

  function metaPair(label, value) {
    var wrap = el("span");
    wrap.appendChild(document.createTextNode(label + " "));
    wrap.appendChild(el("span", "mono", value));
    return wrap;
  }

  function selectRun(traceId) {
    selectedId = traceId;
    Array.prototype.forEach.call(runsEl.querySelectorAll(".run"), function (node) {
      node.classList.toggle("selected", node.dataset.traceId === traceId);
    });
    loadDetail(traceId);
  }

  function makeKpi(label) {
    var box = el("div", "kpi");
    box.appendChild(el("div", "kpi-label", label));
    var value = el("div", "kpi-value");
    box.appendChild(value);
    return { box: box, value: value };
  }

  // The mounted detail shell for the selected run, reused across refreshes so
  // bars are repositioned in place each animation frame and only new spans
  // animate in. Rebuilt on run switch.
  var detailState = null;
  var rafId = null;

  function renderDetail(data) {
    var summary = data.summary;
    if (!detailState || detailState.runId !== summary.traceId) {
      buildDetailShell(summary);
    }
    updateKpis(summary);
    renderLegend();

    var nodes = data.waterfall || [];
    detailState.nodes = nodes;
    detailState.windowStart = typeof summary.startedAtMillis === "number" ? summary.startedAtMillis : 0;
    detailState.maxEnd = nodes.reduce(function (max, n) {
      return n.endMillis > max ? n.endMillis : max;
    }, detailState.windowStart);

    reconcileWaterfall(nodes);
    // A live run may add attributes to the open span after the fact (e.g. a
    // tool result arriving after its arguments) — keep the panel in sync.
    refreshPanelForSelection();
    // Paint the current frame immediately, then keep advancing while this is
    // the newest (current-session) run.
    if (applyFrame()) startLoop();
  }

  function buildDetailShell(summary) {
    // Switching runs invalidates any open selection (rows are rebuilt).
    closePanel();
    detailEl.innerHTML = "";

    var head = el("div", "detail-head");
    var left = el("div");
    left.appendChild(el("div", "detail-title", summary.rootName || summary.traceId));
    left.appendChild(el("div", "detail-sub mono", summary.traceId + (summary.sessionId ? "  ·  session " + summary.sessionId : "")));
    head.appendChild(left);
    if (summary.trigger) {
      var badge = el("span", "badge");
      badge.appendChild(el("span", "dot kind-" + classifyKind(summary.rootName)));
      badge.appendChild(document.createTextNode(summary.trigger));
      head.appendChild(badge);
    }
    detailEl.appendChild(head);

    var kpis = el("div", "kpis");
    var turns = makeKpi("Turns");
    var tokens = makeKpi("Tokens");
    var duration = makeKpi("Duration");
    var spans = makeKpi("Spans");
    [turns, tokens, duration, spans].forEach(function (k) { kpis.appendChild(k.box); });
    detailEl.appendChild(kpis);

    var card = el("div", "card");
    var cardHead = el("div", "card-head");
    cardHead.appendChild(el("span", "", "Waterfall"));
    var controls = el("div", "wf-controls");
    var legend = el("div", "legend");
    controls.appendChild(legend);
    cardHead.appendChild(controls);
    card.appendChild(cardHead);

    var wf = el("div", "waterfall");
    var axis = el("div", "wf-axis");
    axis.appendChild(el("div", "wf-axis-spacer"));
    // The axis ticks are pixel-positioned and rebuilt each frame by renderAxis:
    // at a fixed scale, ticks keep constant spacing and new ones append at the
    // right as time passes.
    var axisTrack = el("div", "wf-axis-track");
    axis.appendChild(axisTrack);
    wf.appendChild(axis);
    var nowEl = el("div", "wf-now");
    wf.appendChild(nowEl);
    card.appendChild(wf);
    detailEl.appendChild(card);

    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    detailState = {
      runId: summary.traceId,
      cardEl: card,
      wfEl: wf,
      axisTrackEl: axisTrack,
      legendEl: legend,
      kpis: { turns: turns.value, tokens: tokens.value, duration: duration.value, spans: spans.value },
      nowEl: nowEl,
      rowsById: {},
      nodes: [],
      windowStart: 0,
      maxEnd: 0,
      scale: 0,
      selectedSpanId: null,
      selectedSig: null,
    };
  }

  function updateKpis(summary) {
    detailState.kpis.turns.textContent = String(summary.turnCount);
    detailState.kpis.duration.textContent = formatDuration(summary.durationMillis);
    detailState.kpis.spans.textContent = String(summary.spanCount);
    detailState.kpis.tokens.textContent = formatTokens(summary.totalTokens) + " ";
    detailState.kpis.tokens.appendChild(
      el("small", "", formatTokens(summary.inputTokens) + " in / " + formatTokens(summary.outputTokens) + " out"),
    );
  }

  function renderLegend() {
    var legend = detailState.legendEl;
    legend.innerHTML = "";
    KINDS.forEach(function (k) {
      var item = el("span", "legend-item");
      item.appendChild(el("span", "legend-swatch " + (KIND_COLOR[k] || "colorVercel")));
      item.appendChild(document.createTextNode(KIND_LABELS[k]));
      legend.appendChild(item);
    });
  }

  // Reconcile rows by span id so existing rows persist across refreshes (only
  // their geometry moves, driven by the frame loop) and only newly-arrived
  // spans fade in. Bar geometry itself is set by layout(), not here.
  function reconcileWaterfall(waterfall) {
    var wf = detailState.wfEl;
    var rowsById = detailState.rowsById;

    var emptyEl = wf.querySelector(".empty");
    if (!waterfall.length) {
      Object.keys(rowsById).forEach(function (id) { rowsById[id].remove(); delete rowsById[id]; });
      if (!emptyEl) wf.appendChild(el("div", "empty", "No spans in this run."));
      return;
    }
    if (emptyEl) emptyEl.remove();

    var incoming = {};
    waterfall.forEach(function (node) { incoming[node.spanId] = true; });
    Object.keys(rowsById).forEach(function (id) {
      if (!incoming[id]) { rowsById[id].remove(); delete rowsById[id]; }
    });

    waterfall.forEach(function (node) {
      var row = rowsById[node.spanId];
      if (row) {
        updateRow(row, node);
      } else {
        row = createRow(node);
        rowsById[node.spanId] = row;
        markEnter(row);
      }
      // Re-appending in waterfall order keeps rows sorted; existing nodes move
      // without re-animating. The absolutely-positioned "now" edge is unaffected.
      wf.appendChild(row);
    });
  }

  function createRow(node) {
    // The color class rides on the row; the dot, bar, and duration read --span-*
    // from it (matching the trace-viewer tree row).
    var row = el("div", "wf-row " + colorClassFor(node.name));
    row.dataset.spanId = node.spanId;

    var label = el("div", "wf-label");
    label.appendChild(el("span", "wf-kind-dot"));
    var name = el("span", "", node.name);
    name.title = node.name;
    label.appendChild(name);
    row.appendChild(label);

    var track = el("div", "wf-track");
    var bar = el("div", "wf-bar");
    track.appendChild(bar);
    var dur = el("div", "wf-dur mono");
    track.appendChild(dur);
    row.appendChild(track);

    row._label = label;
    row._name = name;
    row._bar = bar;
    row._dur = dur;
    row._node = node;
    row.addEventListener("click", function () { selectSpan(row._node); });
    updateRow(row, node);
    return row;
  }

  // Row content that does not depend on the live window: indentation, name, and
  // the duration text (its wall-clock length never changes once captured).
  function updateRow(row, node) {
    row._node = node;
    row._label.style.paddingLeft = Math.min(node.depth, 8) * 12 + "px";
    if (row._name.textContent !== node.name) {
      row._name.textContent = node.name;
      row._name.title = node.name;
    }
    row._dur.textContent = formatDuration(node.durationMillis);
  }

  function markEnter(row) {
    row.classList.add("wf-enter");
    setTimeout(function () { row.classList.remove("wf-enter"); }, 300);
  }

  // Axis stepping + label formatting ported from @vercel/trace-viewer
  // (util/timing.ts) so ticks land on nice round intervals with sensible units.
  var TIME_UNIT_MS = { milliseconds: 1, seconds: 1000, minutes: 60000, hours: 3600000 };
  var AXIS_STEP_MULTIPLIERS = {
    milliseconds: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
    seconds: [1, 2, 5, 10, 15, 20, 30, 60],
    minutes: [1, 2, 5, 10, 15, 20, 30, 60],
    hours: [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168],
  };
  var AXIS_TARGET_LABEL_COUNT = 6;

  function resolveAxisUnit(ms) {
    if (ms >= TIME_UNIT_MS.hours) return "hours";
    if (ms >= TIME_UNIT_MS.minutes) return "minutes";
    if (ms >= TIME_UNIT_MS.seconds) return "seconds";
    return "milliseconds";
  }

  function getNiceAxisStep(idealStep, unit) {
    var unitMs = TIME_UNIT_MS[unit];
    var m = idealStep / unitMs;
    if (m <= 0) return unitMs;
    if (m < 1) {
      var mag = Math.pow(10, Math.floor(Math.log10(m)));
      var norm = m / mag;
      var mult = [1, 2, 2.5, 5, 10].find(function (c) { return c >= norm; });
      return (mult || 10) * mag * unitMs;
    }
    var mult2 = AXIS_STEP_MULTIPLIERS[unit].find(function (c) { return c >= m; });
    if (mult2 !== undefined) return mult2 * unitMs;
    var mag2 = Math.pow(10, Math.floor(Math.log10(m)));
    var norm2 = m / mag2;
    var fb = [1, 2, 5, 10].find(function (c) { return c >= norm2; });
    return (fb || 10) * mag2 * unitMs;
  }

  function getTimelineAxisConfig(fullDuration) {
    var idealStep = fullDuration / AXIS_TARGET_LABEL_COUNT;
    var markerDuration = getNiceAxisStep(idealStep, resolveAxisUnit(idealStep));
    return { labelUnit: resolveAxisUnit(markerDuration), markerDuration: markerDuration };
  }

  var wholeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  var tlFmtCache = {};
  function formatTimelineValue(v) {
    var mag = Math.abs(v);
    var d = mag >= 100 ? 0 : mag >= 10 ? 1 : mag >= 1 ? 2 : Math.min(6, Math.max(2, Math.ceil(-Math.log10(mag)) + 2));
    var f = tlFmtCache[d];
    if (!f) { f = new Intl.NumberFormat(undefined, { maximumFractionDigits: d }); tlFmtCache[d] = f; }
    return f.format(v);
  }

  function formatTimelineTime(ms, unit) {
    if (ms === 0) return "0";
    if (unit === "milliseconds") return wholeFmt.format(ms) + "ms";
    if (unit === "seconds") return formatTimelineValue(ms / 1000) + "s";
    if (unit === "minutes") return formatTimelineValue(ms / 60000) + "m";
    if (unit === "hours") return formatTimelineValue(ms / 3600000) + "h";
    if (ms < 1000) return wholeFmt.format(ms) + "ms";
    var total = Math.round(ms / 1000);
    if (total >= 3600) {
      var h = Math.floor(total / 3600);
      var mh = Math.floor((total % 3600) / 60);
      return mh > 0 ? h + "h " + mh + "m" : h + "h";
    }
    if (total >= 60) {
      var mm = Math.floor(total / 60);
      var s = total % 60;
      return s > 0 ? mm + "m " + s + "s" : mm + "m";
    }
    return formatTimelineValue(ms / 1000) + "s";
  }

  // Lay the timeline out by fitting the window [runStart, windowEnd] to the
  // track width, so every span is always visible. As windowEnd advances each
  // frame (while live), the axis ticks forward and spans reflow; percentages
  // mean a growing window gently compresses them instead of scrolling them off.
  function layout(windowEnd) {
    var start = detailState.windowStart;
    var span = Math.max(windowEnd - start, 1);
    detailState.nodes.forEach(function (node) {
      var row = detailState.rowsById[node.spanId];
      if (!row) return;
      var left = clampPct(((node.startMillis - start) / span) * 100);
      var width = ((node.endMillis - node.startMillis) / span) * 100;
      if (width < 0.15) width = 0.15;
      if (left + width > 100) left = Math.max(0, 100 - width);
      row._bar.style.left = left + "%";
      row._bar.style.width = width + "%";
      positionDuration(row, left, width);
    });
    renderAxis(span);
  }

  function clampPct(value) {
    return value < 0 ? 0 : value > 100 ? 100 : value;
  }

  // Ticks at nice round intervals (ported axis config), targeting ~6 labels
  // across the fitted window. As the window grows a new label appears.
  function renderAxis(span) {
    var track = detailState.axisTrackEl;
    track.textContent = "";
    var cfg = getTimelineAxisConfig(span);
    for (var t = 0; t <= span + 0.5; t += cfg.markerDuration) {
      var pct = (t / span) * 100;
      if (pct > 100) break;
      var tick = el("div", "wf-tick");
      tick.style.left = pct + "%";
      tick.appendChild(el("span", "wf-tick-label mono", formatTimelineTime(t, cfg.labelUnit)));
      track.appendChild(tick);
    }
  }

  // The duration label rides its bar: to the right of the bar's end, or flipped
  // to the left when the bar reaches too far right for the label to fit.
  function positionDuration(row, left, width) {
    var dur = row._dur;
    if (left + width <= 82) {
      dur.classList.remove("dur-left");
      dur.classList.add("dur-right");
      dur.style.right = "";
      dur.style.left = left + width + "%";
    } else {
      dur.classList.remove("dur-right");
      dur.classList.add("dur-left");
      dur.style.left = "";
      dur.style.right = 100 - left + "%";
    }
  }

  // Render one frame. While following the live run, the window end tracks the
  // wall clock so the timeline ticks forward continuously (fit-to-window keeps
  // every span visible, gently compressing as time passes). A run we are not
  // following (an older one) is fit to its own last span — static, true scale.
  function applyFrame() {
    if (!detailState || !detailState.nodes.length) return false;
    var isLive = detailState.runId === followingRunId;
    layout(isLive ? Math.max(Date.now(), detailState.maxEnd) : detailState.maxEnd);
    detailState.cardEl.classList.toggle("is-live", isLive);
    return isLive;
  }

  function tick() {
    rafId = null;
    if (applyFrame()) startLoop();
  }

  function startLoop() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  // --- Span detail panel -----------------------------------------------------

  function firstAttr(attrs, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = attrs[keys[i]];
      if (v != null && v !== "") return v;
    }
    return undefined;
  }

  // Render an attribute value as readable text: JSON strings and structured
  // values are pretty-printed; everything else is shown as-is.
  function pretty(value) {
    if (value == null) return "";
    if (typeof value === "string") {
      var s = value.trim();
      if (s.charAt(0) === "{" || s.charAt(0) === "[") {
        try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) {}
      }
      return value;
    }
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  function attrRow(key, value) {
    var dl = el("div", "attr");
    dl.appendChild(el("span", "attr-key", key));
    var val = el("span", "attr-val", value);
    val.title = value;
    dl.appendChild(val);
    return dl;
  }

  function detailGroup(name, collapsed) {
    var group = el("div", "dg" + (collapsed ? " collapsed" : ""));
    var head = el("button", "dg-head");
    head.type = "button";
    head.appendChild(el("span", "", name));
    head.appendChild(el("span", "dg-chevron", "\\u25BC"));
    var body = el("div", "dg-body");
    head.addEventListener("click", function () { group.classList.toggle("collapsed"); });
    group.appendChild(head);
    group.appendChild(body);
    return { group: group, body: body };
  }

  function fieldBlock(label, value) {
    var f = el("div", "field");
    f.appendChild(el("div", "field-label", label));
    f.appendChild(el("pre", "code", value));
    return f;
  }

  function selectSpan(node) {
    if (!detailState) return;
    detailState.selectedSpanId = node.spanId;
    detailState.selectedSig = null;
    appEl.classList.add("panel-open");
    updateSelectedRow();
    renderPanel(node);
  }

  function closePanel() {
    appEl.classList.remove("panel-open");
    panelEl.innerHTML = "";
    panelEl.className = "span-panel";
    if (detailState) {
      detailState.selectedSpanId = null;
      detailState.selectedSig = null;
      Object.keys(detailState.rowsById).forEach(function (id) {
        detailState.rowsById[id].classList.remove("selected");
      });
    }
  }

  function updateSelectedRow() {
    if (!detailState) return;
    var sel = detailState.selectedSpanId;
    Object.keys(detailState.rowsById).forEach(function (id) {
      detailState.rowsById[id].classList.toggle("selected", id === sel);
    });
  }

  // On each data refresh, keep the open panel pointed at the fresh node. Skip
  // the rebuild unless the node actually changed (so pure geometry ticks and
  // unrelated-span updates don't reset collapse/scroll state in the panel).
  function refreshPanelForSelection() {
    if (!detailState || !detailState.selectedSpanId) return;
    var row = detailState.rowsById[detailState.selectedSpanId];
    if (!row) { closePanel(); return; }
    updateSelectedRow();
    renderPanel(row._node);
  }

  function signatureFor(node) {
    return node.endMillis + ":" + node.durationMillis + ":" + Object.keys(node.attributes || {}).length;
  }

  function renderPanel(node) {
    var sig = signatureFor(node);
    if (sig === detailState.selectedSig) return;
    detailState.selectedSig = sig;

    var attrs = node.attributes || {};
    panelEl.innerHTML = "";
    panelEl.className = "span-panel " + colorClassFor(node.name);

    var top = el("div", "span-panel-top");
    var heading = el("div", "span-panel-heading");
    heading.appendChild(el("span", "span-panel-dot"));
    heading.appendChild(el("span", "span-panel-dur mono", formatDuration(node.durationMillis)));
    var nm = el("span", "span-panel-name", node.name);
    nm.title = node.name;
    heading.appendChild(nm);
    top.appendChild(heading);
    var close = el("button", "span-panel-close", "\\u2715");
    close.type = "button";
    close.setAttribute("aria-label", "Close span details");
    close.addEventListener("click", closePanel);
    top.appendChild(close);
    panelEl.appendChild(top);

    var body = el("div", "span-panel-body");

    var model = firstAttr(attrs, MODEL_KEYS);
    var inTok = firstAttr(attrs, INPUT_TOKEN_KEYS);
    var outTok = firstAttr(attrs, OUTPUT_TOKEN_KEYS);
    var cacheTok = firstAttr(attrs, CACHE_TOKEN_KEYS);
    var finish = firstAttr(attrs, FINISH_KEYS);
    var op = attrs["gen_ai.operation.name"];
    var chips = el("div", "chips");
    function chip(label, value) {
      var c = el("span", "chip");
      c.appendChild(document.createTextNode(label + " "));
      c.appendChild(el("b", "mono", String(value)));
      chips.appendChild(c);
    }
    if (model != null) chip("model", model);
    if (inTok != null) chip("in", formatTokens(Number(inTok)));
    if (outTok != null) chip("out", formatTokens(Number(outTok)));
    if (cacheTok != null && Number(cacheTok) > 0) chip("cached", formatTokens(Number(cacheTok)));
    if (finish != null) chip("finish", Array.isArray(finish) ? finish.join(", ") : finish);
    if (op != null) chip("op", op);
    if (chips.childNodes.length) body.appendChild(chips);

    if (node.status && node.status.code === 2) {
      var eg = detailGroup("Error");
      eg.group.classList.add("dg-error");
      eg.body.appendChild(fieldBlock("Message", node.status.message || "Span reported an error status."));
      body.appendChild(eg.group);
    }

    var toolName = firstAttr(attrs, TOOL_NAME_KEYS);
    var toolArgs = firstAttr(attrs, TOOL_ARGS_KEYS);
    var toolResult = firstAttr(attrs, TOOL_RESULT_KEYS);
    if (toolName != null || toolArgs != null || toolResult != null) {
      var tg = detailGroup("Tool call");
      if (toolName != null) tg.body.appendChild(attrRow("name", String(toolName)));
      if (toolArgs != null) tg.body.appendChild(fieldBlock("Arguments", pretty(toolArgs)));
      if (toolResult != null) tg.body.appendChild(fieldBlock("Result", pretty(toolResult)));
      body.appendChild(tg.group);
    }

    var sys = firstAttr(attrs, SYSTEM_KEYS);
    var inputMsgs = firstAttr(attrs, INPUT_MSG_KEYS);
    var outputMsgs = firstAttr(attrs, OUTPUT_MSG_KEYS);
    if (sys != null || inputMsgs != null || outputMsgs != null) {
      var mg = detailGroup("Messages");
      if (sys != null) mg.body.appendChild(fieldBlock("System instructions", pretty(sys)));
      if (inputMsgs != null) mg.body.appendChild(fieldBlock("Input", pretty(inputMsgs)));
      if (outputMsgs != null) mg.body.appendChild(fieldBlock("Output", pretty(outputMsgs)));
      body.appendChild(mg.group);
    }

    var og = detailGroup("Overview");
    og.body.appendChild(attrRow("kind", KIND_LABELS[classifyKind(node.name)] || "Span"));
    og.body.appendChild(attrRow("duration", formatDuration(node.durationMillis)));
    var offset = node.startMillis - detailState.windowStart;
    og.body.appendChild(attrRow("start", "+" + formatDuration(offset >= 0 ? offset : 0)));
    og.body.appendChild(attrRow("span id", node.spanId));
    if (node.parentSpanId) og.body.appendChild(attrRow("parent", node.parentSpanId));
    body.appendChild(og.group);

    var keys = Object.keys(attrs).sort();
    if (keys.length) {
      var ag = detailGroup("Attributes (" + keys.length + ")", true);
      keys.forEach(function (k) {
        ag.body.appendChild(attrRow(k, truncate(String(attrs[k]), 300)));
      });
      body.appendChild(ag.group);
    }

    panelEl.appendChild(body);
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && appEl.classList.contains("panel-open")) closePanel();
  });

  function loadDetail(traceId) {
    var url = DATA_PATH + "/" + encodeURIComponent(traceId);
    fetch(url, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(renderDetail)
      .catch(function () {
        detailEl.innerHTML = "";
        detailEl.appendChild(el("div", "empty", "Could not load this run."));
      });
  }

  // Re-fetch the runs list so new runs appear and existing rows update their
  // turns/tokens/duration. Auto-selects the most recent run only when nothing
  // is selected yet, and loads its detail on first paint.
  function loadRuns() {
    return fetch(DATA_PATH, { headers: { accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : { runs: [] }; })
      .then(function (data) {
        var runs = data.runs || [];
        runsById = {};
        runs.forEach(function (r) { runsById[r.traceId] = r; });
        newestRunId = runs.length ? runs[0].traceId : null;
        // Follow (tick forward) the newest run once it has been active recently,
        // and keep following it thereafter — a live session never freezes on
        // idle. A run opened cold long after it finished is not followed, so it
        // renders static at its true scale rather than ticking off into the past.
        var newest = runs[0];
        if (newest) {
          var lastEnd = newest.startedAtMillis + newest.durationMillis;
          var recent = Date.now() - lastEnd < FOLLOW_START_MS;
          followingRunId = recent || followingRunId === newest.traceId ? newest.traceId : null;
        } else {
          followingRunId = null;
        }
        if (selectedId === null && runs.length) selectedId = runs[0].traceId;
        renderRuns(runs);
        if (selectedId !== null && detailEl.querySelector(".detail-title") === null && runsById[selectedId]) {
          loadDetail(selectedId);
        }
        // The newest run may have just become live (or been superseded); make
        // sure the frame loop reflects the current liveness.
        startLoop();
      })
      .catch(function () {});
  }

  function setLive(isConnected) {
    liveEl.dataset.state = isConnected ? "on" : "off";
    liveLabelEl.textContent = isConnected ? "Live" : "Reconnecting…";
    // Kick the frame loop on (re)connect in case it had stopped.
    if (isConnected) startLoop();
  }

  // A trace changed on disk: refresh the runs list, and if the changed run is
  // the one currently open, re-render its waterfall (respecting Verbose). When
  // nothing is selected, loadRuns auto-selects the most recent run and paints
  // its detail, so a fresh session shows the first run appearing live.
  function onChange(runId) {
    var wasSelected = selectedId;
    loadRuns().then(function () {
      if (runId && runId === selectedId && runId === wasSelected) {
        loadDetail(selectedId);
      }
    });
  }

  // Live updates over Server-Sent Events. EventSource reconnects on its own
  // after a drop, so onerror only reflects the connection state in the UI.
  function connectStream() {
    var source;
    try {
      source = new EventSource(STREAM_PATH);
    } catch (e) {
      return;
    }
    source.addEventListener("ready", function () { setLive(true); });
    source.addEventListener("change", function (event) {
      setLive(true);
      var runId = null;
      try { runId = JSON.parse(event.data).runId; } catch (e) {}
      onChange(runId);
    });
    source.onopen = function () { setLive(true); };
    source.onerror = function () { setLive(false); };
  }

  // The script tag sits at the end of <body>, so the DOM is already parsed.
  void VIEWER_PATH;
  loadRuns();
  connectStream();
})();
</script>
</body>
</html>
`;
