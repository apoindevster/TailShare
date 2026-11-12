---
name: TailShare
description: A neon communications console for deliberate, browser-to-browser file sharing.
colors:
  cyan: '#67f5df'
  pink: '#ff70c9'
  orange: '#ffad70'
  ink: '#0b101b'
  panel: '#121b2b'
  line: '#2c3950'
  text: '#edf4ff'
  muted: '#a7b8d0'
typography:
  display:
    fontFamily: Chakra Petch, sans-serif
    fontSize: clamp(42px, 4.6vw, 62px)
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: -0.035em
  headline:
    fontFamily: Chakra Petch, sans-serif
    fontSize: 25px
    fontWeight: 500
    letterSpacing: -0.4px
  title:
    fontFamily: Chakra Petch, sans-serif
    fontSize: 19px
    fontWeight: 500
    letterSpacing: -0.2px
  body:
    fontFamily: IBM Plex Sans, sans-serif
    fontSize: 15px
    fontWeight: 400
  support:
    fontFamily: IBM Plex Sans, sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: IBM Plex Sans, sans-serif
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.3
  caption:
    fontFamily: IBM Plex Sans, sans-serif
    fontSize: 11px
    fontWeight: 400
rounded:
  chip: 3px
  control: 4px
  bay: 5px
  rail: 6px
  console: 7px
spacing:
  tight: 4px
  icon: 8px
  row: 12px
  compact: 16px
  group: 20px
  panel: 24px
  section: 32px
  shell: 48px
components:
  button-primary:
    backgroundColor: '{colors.cyan}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: 12px 17px
  button-primary-hover:
    backgroundColor: '#a1ffef'
  button-secondary:
    backgroundColor: '#1a283b'
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: 12px 17px
  button-secondary-hover:
    backgroundColor: '#293950'
  button-danger:
    backgroundColor: '#2a2024'
    textColor: '#ffc2a3'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: 12px 17px
    width: 100%
  button-danger-hover:
    backgroundColor: '#44302f'
  button-icon:
    textColor: '{colors.muted}'
    rounded: '{rounded.control}'
  button-icon-hover:
    backgroundColor: '#273a4a'
    textColor: '{colors.cyan}'
  button-text:
    textColor: '{colors.pink}'
    typography: '{typography.caption}'
    padding: 10px 0
  share-key-field:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.text}'
    rounded: '{rounded.control}'
    padding: 12px
    width: 100%
  mode-navigation:
    textColor: '{colors.muted}'
    height: 60px
    padding: 0 21px
  mode-navigation-active:
    textColor: '{colors.cyan}'
  live-chip:
    backgroundColor: '#163b35'
    textColor: '{colors.cyan}'
    typography: '{typography.caption}'
    rounded: '{rounded.chip}'
    padding: 2px 6px
  console:
    backgroundColor: '{colors.panel}'
    rounded: '{rounded.console}'
  file-row:
    textColor: '{colors.text}'
    padding: 0 21px
---

# Design System: TailShare

## Overview

**Creative North Star: "The Neon Communications Console"**

TailShare uses the user’s pinned retro cyberpunk palette to make a practical transfer interface feel like a small communications console. Ink navy carries the workspace; cyan, magenta, and warm orange supply precise signals. The character comes from squared typography, compact controls, thin rules, and structured file rows.

The interface stays readable while files, folders, connection details, and feedback change. Brand expression lives in the paired arrow mark, the restrained device-route drawing, and the cyan/magenta relationship. These are CSS and inline vector treatments; the shipping interface contains no raster imagery. Fonts are self-hosted through @fontsource.

**Key Characteristics:**

- Dark navy surfaces with pale text and three distinct neon accent roles.
- Chakra Petch for identity and headings; IBM Plex Sans for task content.
- Flat tonal layers, thin dividers, and modest rectangular corners.
- Stable file columns, explicit action rails, and visible session state.
- Brief state transitions with a complete reduced-motion override.

This document captures the current system in `src/style.css`, `src/App.tsx`, and `src/main.tsx`. The frontmatter is normative for the extracted values. The app-specific composition remains in `.impeccable/surfaces/app.md`; it is not a mandatory template for every future surface.

## Colors

Bright signals sit on cool, low-luminance navy. Color is concentrated around actions, identity, and state rather than spread across entire panels.

### Primary

- **Signal Cyan** (`cyan`): primary button fill, active mode underline, connected indicators, progress, and confirmatory feedback.

### Secondary

- **Link Magenta** (`pink`): share-session iconography, link-related actions, the second brand arrow, title punctuation, and text selection.

### Tertiary

- **Warm Orange** (`orange`): keyboard focus, folder icons, and warning cues. Warning and destructive surfaces use the restrained warm tints recorded in component styles.

### Neutral

- **Ink Navy** (`ink`): page ground, key-entry field, and text on bright cyan controls.
- **Panel Navy** (`panel`): the working console and selected form backgrounds.
- **Rule Slate** (`line`): container edges, navigation dividers, and supporting rules.
- **Pale Ice** (`text`): primary reading and control text.
- **Muted Blue** (`muted`): explanatory copy, labels, sizes, and secondary metadata.

**The Signal Roles Rule.** Use cyan for primary actions, selected navigation, and connected-state emphasis; use magenta for share-link and session identity; use orange for warnings, folder identity, and keyboard focus. Preserve the accompanying text or icon so color is never the only state cue.

Hover, warning, error, and link surfaces use local colors already present in the stylesheet; component variants and sidecar snippets retain them. Sidecar tonal ramps are synthesized preview aids, not an expanded application palette.

## Typography

**Display Font:** Chakra Petch, with sans-serif fallback. Self-hosted weights (500, 600, 700) are imported; the visible heading system primarily uses medium and semibold.

**Body Font:** IBM Plex Sans, with sans-serif fallback. Self-hosted weights (400, 500, 600) cover reading, navigation, and controls.

**Character:** Angular headings carry the retro identity while the body face keeps dense operational content readable. Both use proportional letterforms; sizes, byte counts, and session values use tabular numerals where alignment matters.

### Hierarchy

- **Display:** the dominant two-line page heading, using the frontmatter’s fluid display role. At the tablet breakpoint it becomes fixed (48px), then phone-sized (43px).
- **Headline:** the centered empty-bay and connection-entry headings; these shrink on phones (23px).
- **Title:** section headings in the session rail; these shrink on phones (18px).
- **Body:** the page’s base reading size. Introductory copy uses open leading (1.7) and adapts with the shell.
- **Support:** session descriptions and empty-state instructions, with relaxed leading.
- **Label:** compact semibold button text. Navigation uses medium weight (500); phone controls use smaller type (12px).
- **Caption:** counts, hints, and compact metadata. Some phone-only metadata reduces further (10px); do not apply that reduction to primary instructions or actions.

**The Two Voices Rule.** Use Chakra Petch for headings and brand identity, and IBM Plex Sans for controls, filenames, instructions, and metadata. Technical content does not require a third or monospaced font.

## Layout

The app uses a centered shell with a maximum width (1336px), desktop horizontal inset from the shell spacing token, and a minimum supported viewport width (320px). Its working area has a flexible console and a narrow session column (292px), separated by a modest gap (25px). These are the current app’s composition values, not a required grid for future pages.

Responsive rules are explicit:

| Viewport | Implemented behavior |
| --- | --- |
| At least 1450px | Give the introduction more vertical room and increase the empty-bay minimum height to 340px. |
| At most 1100px | Reduce shell inset to 30px, session width to 260px, and column gap to 22px; let the action rail wrap. |
| At most 800px | Use 24px shell insets and a single workspace column; the session rail gains a bordered navy surface below the console. |
| At most 560px | Use 17px shell insets, hide the route illustration, stack relevant actions, and expand search to the available width. |

The extracted spacing scale describes recurring distances rather than enforcing a mathematical grid: tight icon details, compact row gaps, padded panel interiors, then larger section and shell offsets. The file browser uses a flexible name column and fixed size/action columns (70px / 62px), reduced on phones (48px / 32px). Rows have minimum height (53px desktop, 55px phone); the scrolling file region is bounded (350px). Supporting security prose is capped at a comfortable measure (70ch).

**The Stable Columns Rule.** Keep the file name flexible and the size and action columns aligned. Let long paths wrap in navigation, truncate ordinary filenames with a full-path title, and keep actions reachable on small screens.

## Elevation & Depth

Depth is tonal and structural. The console separates from the page through Panel Navy, a single-pixel Rule Slate edge, and a slightly lighter header strip. Inputs sit deeper; action rails and feedback strips form horizontal subdivisions. Small live, link, and warning surfaces use local tinted backgrounds. There are no shipping shadow tokens.

**The Flat Layers Rule.** Separate surfaces with navy tone changes and thin borders. The implemented system has no box shadows, blur, or gradients; its neon character comes from solid accent color.

## Shapes

Rectangular forms have small, purpose-specific radii from the frontmatter: controls, chips, bays, the compact session rail, and the enclosing console. Mode buttons stay square along their underline. Dividers and container outlines are thin (1px), with the active mode indicator slightly stronger (2px).

The visual vocabulary also includes square registration-like corners around the empty-bay icon, a trio of small console marks, and paired directional arrows for the brand. Circular dots are reserved for compact status indications. The route drawing uses inline outline icons and CSS lines; no image provenance entries are required because no raster assets ship.

## Components

### Buttons

Primary buttons are solid Signal Cyan with Ink Navy text. Secondary buttons use a muted navy fill and a slate outline; destructive session controls use warm text, a warm outline, and a subdued dark fill. Their shared padding and type are in frontmatter; the desktop minimum height is compact (43px), increasing on phones (44px).

Primary and secondary hover fills brighten; destructive controls deepen their warm surface. Icon buttons use compact targets (32px minimum) and gain a tinted hover background and border. Phone file actions increase their target (36px by 40px). Text actions stay magenta and lightweight. Disabled buttons retain their form at reduced opacity (0.45) and use a not-allowed cursor.

All interactive controls use the same visible orange outline (2px, offset 4px). Buttons transition background, color, and border-color briefly (150ms, ease). The implementation has no press transform or elaborate animation.

### Chips

The **Live** chip combines a dark green surface with cyan text and the chip radius. It accompanies the active sending mode; the written label carries the state alongside color.

### Cards / Containers

The **transfer console** is the primary bordered container. Its header, mode strip, content area, action rail, and feedback are divided with thin rules. It clips to the console radius. The session rail becomes a separate framed surface at smaller widths; the empty drop bay uses a dashed outline and a darker inset ground.

### Inputs / Fields

The share-key textarea has an inset Ink Navy ground, thin outline, control radius, and comfortable internal padding. Its vertical size is bounded (75px minimum, 180px maximum), with vertical resizing and wrapping for long credentials. Search is compact on desktop and fills the toolbar row on phones. The private-link field uses a magenta-tinted surround and selects its readonly value on focus. Native selects and checkboxes preserve browser behavior; checkboxes use the cyan accent. The expiry control uses a full-width select and, for usage limits, a labelled number input with a 1–1,000 range and visible validation. Its helper text explains time expiry, tab lifetime, or how a recipient connection consumes a use.

### Navigation

The mode switch is a labelled group of two pressed-state buttons. Its active item uses cyan text and a bottom rule; hover brightens the text. The strip becomes shorter on phones (56px), while retaining both modes. Breadcrumbs wrap long paths and use compact chevrons; the current final path segment receives cyan emphasis.

### File Browser and Feedback

The file browser is the signature operational component: stable columns, orange folders, cool file icons, muted tabular sizes, and labelled row actions. Long filenames truncate with their full path available through the title attribute. Folder controls and breadcrumbs navigate the current selection without changing the enclosing console structure.

Progress uses a thin cyan bar (5px) with actual transferred and total bytes. Errors use a warm dark strip and a dismiss button; notices use a cyan-tinted strip; working messages use a rotating outline loader and a cancel action when available. The feedback region is polite live content, with errors explicitly marked as alerts. The loader rotates continuously (1.3s, linear); reduced-motion preferences disable all animations and transitions.

**The Honest State Rule.** Show progress, connection counts, and transferred bytes only from live application state. Pair a disabled action with the current selection or connection context, and keep errors, notices, and work-in-progress messages legible.

### Link Download Confirmation

Opening a share link presents a native modal dialog once the validated file list arrives. It uses the existing navy panel, thin slate border, rectangular corners, cyan download action, and orange focus treatment. The scrollable list shows full relative paths and sizes; long paths wrap. A format selector defaults multiple files to ZIP when supported, while a single file retains its original name. Download limits are checked before enabling confirmation. “Browse first,” Close, or Escape dismisses without downloading; key-only connections go straight to browsing. The dialog fits the viewport and stacks its actions on phones.

## Do's and Don'ts

### Do:

- **Do** preserve the navy, cyan, magenta, and orange identity chosen by the user.
- **Do** use the defined accent roles and an orange keyboard-focus outline on interactive controls.
- **Do** keep self-hosted Chakra Petch and IBM Plex Sans in their established heading and task-content roles.
- **Do** use stable file rows, tabular numerals for quantities, and explicit labels for icon actions.
- **Do** reflow the workspace and controls at the implemented breakpoints, and honor reduced-motion preferences.
- **Do** derive visible session and transfer feedback from real state.

### Don't:

- **Don’t** replace the pinned neon console identity with a neutral dashboard aesthetic.
- **Don’t** use neon fills for long reading surfaces or remove the navy space separating accent elements.
- **Don’t** introduce shadows, blur, or gradients into existing flat components without an intentional design-system change.
- **Don’t** communicate selected, live, disabled, or warning states through color alone.
- **Don’t** add fabricated throughput, progress, or recipient activity.
- **Don’t** treat the sidecar’s generated tonal ramps as additional shipping color tokens.
