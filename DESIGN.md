---
name: HAB-1 Ground Station
description: An operations console for one balloon flight, in the grammar of professional telemetry software (Foxglove Studio, NASA Open MCT, SondeHub tracker).
colors:
  bg: "#08090b"
  surface-1: "#0f1114"
  surface-2: "#13161a"
  surface-3: "#191d22"
  line: "#1d2127"
  line-strong: "#2a3038"
  text: "#e7e9ec"
  text-2: "#a3a9b1"
  text-3: "#6a727b"
  accent: "#6d9cff"
  nominal: "#3ecf8e"
  caution: "#e5b453"
  alarm: "#f0605a"
  predicted: "#e07ab8"
  measured: "#63b8e3"
  track: "#f1f3f5"
  light-bg: "#eef0f3"
  light-surface-1: "#ffffff"
  light-surface-2: "#f6f7f9"
  light-surface-3: "#eceef2"
  light-line: "#dde1e6"
  light-line-strong: "#c9cfd6"
  light-text: "#1a1e23"
  light-text-2: "#4f5862"
  light-text-3: "#7a838d"
  light-track: "#15181c"
typography:
  ui:
    fontFamily: "'Red Hat Text', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  value:
    fontFamily: "'Red Hat Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
  scale:
    xs: "11px"
    sm: "12px"
    md: "13px"
    lg: "15px"
    xl: "20px"
    readout: "22px"
rounded:
  chip: "2px"
  sm: "3px"
  md: "4px"
  card: "8px"
  pill: "10px"
  group: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  panel-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-2}"
    height: "32px"
  button:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "28px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: "28px"
---

## Overview
A dense, calm operations console. It is a tool first: the map, the event log and the inspector are the product, and nothing is decoration. It reads the way Foxglove Studio and NASA Open MCT read: dark graphite shell, 1px rules, small precise type, monospaced values, semantic colour only where state lives. A daylight theme exists for projectors and bright rooms. Two modes share one layout: **Live** (served by the ground station laptop, streaming the hardware) and **Archive** (static, replaying the 31 Oct flight and sessions recorded on Arkiv).

## Colors
Graphite surfaces step up in lightness for depth (`bg` < `surface-1` < `surface-2` < `surface-3`). Colour carries state, never decoration:
- `nominal` verified, healthy, settled · `caution` pending, waiting, degraded · `alarm` rejected, failed, attack.
- `track` is what really happened; `predicted` is anything a model produced (Tawhiri courses, landing estimates); `measured` is wind and sensor data from the payload.
- `accent` is reserved for interaction: focus, selection, the primary action.
Light theme swaps the `light-*` tokens in; semantics are unchanged.

## Typography
Red Hat Text (UI) and Red Hat Mono (values), one engineered superfamily, at 13px for the shell, 11px muted sentence-case labels (no tracked uppercase eyebrows), monospaced 12px for every value, time, key and hash, tabular numerals always. Readouts in the inspector use 22px mono. No display type.

## Layout
App shell: 44px top bar; left rail 272px (Systems and Operations); centre map with a 34px time conductor beneath it and a 240px bottom dock (Event log, Plots, Frames); right inspector 360px (Fix, Prediction, Arkiv, Ledger). Below 1180px the left rail collapses; below 820px panels stack under the map.

## Elevation & Depth
Nearly flat: 1px `line` rules, surface steps and a 1px inner top highlight on panels. Floating elements (system-flow cards, toasts, popovers) get 8px radius and a soft shadow (0 12px 32px rgba(0,0,0,.45)). Status changes are announced by a 3px tinted ring flash on the affected card.

## Shapes
3px radius on panels, buttons, inputs. Status dots are 8px circles. Map symbols: circles for fixes, crosses for rejected frames.

## Components
- System flow: cards on a dotted grid in three dashed groups (in the air, on the ground, public infrastructure); edges are animated dashes when live; a coloured packet travels an edge only when that real event happens.
- Transactions ledger: chain tag, action, status pill (submitted with spinner → confirmed ✓), block/consensus, cost, explorer link; new rows flash in.
- Demo runbook: numbered steps that tick themselves from real events.
- Toasts: forged frame rejected, sale settled, first Arkiv confirmation.
- Panel header: 32px, `surface-2`, 12px semibold title, optional actions on the right.
- Status row: dot + label + mono value, right-aligned.
- Event log row: UTC time (mono, text-3) · source tag · message · optional link; verdict colours on the message only.
- Buttons: 28px, `surface-3`; primary uses `accent`; the attack action (inject a fake frame) uses an `alarm` outline.

## Do's and Don'ts
- Do label every number with its unit and every value with its source (radio, Pi, Arkiv, Hedera, model).
- Do show "not attested" for 0G until 0G attests a model; never fake a live value in Archive mode.
- Don't use glow, gradients, glass, large display type, or tracked uppercase labels.
