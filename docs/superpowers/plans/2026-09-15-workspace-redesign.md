# Workspace redesign (issue #43)

**Goal:** the first screen is the developer workspace — Yurt's name, one
sentence, and the terminal, one action from live — with the Jupyter cell as part
of the same workspace; Notebook/Lab, install and the in-browser proof stay
discoverable but secondary. Behaviour, sandbox lifecycle, isolation gating and
the mobile warning are unchanged.

## Structure

- `index.html` becomes the workspace. The terminal pane opens with a single
  action, _Start the sandbox_; the boot runs in place (`src/page.ts` waits for
  the click, or for `?start`). The Python cell sits under the terminal as the
  second pane of the same workspace. The header carries the wordmark, status,
  network state, and the links (Notebook, JupyterLab, source).
- `terminal.html` redirects to `./?start=1`, so every existing link and the
  acceptance flows keep working and boot straight away.
- Below the workspace, two compact secondary strips: _Run it on your machine_
  (the app / command line, one choice per platform down the left) and _Is this
  really running in your browser?_ as a collapsed disclosure with the same three
  checks and the byte check.
- Phones: the existing note, above the workspace; the isolation gate and the
  `unsupported.html` redirect move into `page.ts` and only apply to the in-tab
  transport.

## Tokens

- **Color** — felt and night: ground `#161a21` (not near-black), pane `#1c212a`,
  rule `#2c3340`, text `#e6e1d7` (wool, not white), muted `#9a948a`, ochre
  `#e0a458` (the one warm accent: the prompt, the primary action, the focused
  pane edge), sky `#8fb4d9` (links and secondary actions), moss `#9fc79a`
  (ready/ok), ember `#e08a7a` (errors/offline).
- **Type** — the workspace and everything in it is one monospace family
  (`ui-monospace` stack, 14px in the terminal, 13px chrome); the wordmark and
  the one lead sentence are a system serif
  (`"Iowan Old Style",
  "Palatino Linotype", Georgia`) — the tent against the
  machine. Sentence case throughout; no uppercase labels; no numbering on the
  three checks (they are parallel, not a sequence).
- **Layout** — left-aligned, content width 1040px, 16px gutters. Header 56px.
  Terminal pane 56vh on desktop, 40vh under 720px; the cell pane follows.
  Secondary strips share the pane style but a quieter border.
- **Motion** — one moment: when _Start the sandbox_ is pressed the button yields
  to the boot status line inside the pane; nothing else moves.
- **Principle** — the terminal is the memorable thing. Everything else is quiet,
  flush-left, and one shade quieter than the pane it sits next to.

## Review against the generic defaults

Near-black + one acid accent: no — deep slate with two temperatures (ochre, sky)
and warm text. Cream/serif/terracotta: no. Card kit: panes are structural
(terminal, cell, strips), same radius because they are the same kind of thing;
no shadows. Template chrome: no eyebrows, no middle-dot strings, no arrows, no
all-caps. Hero: the live terminal itself, with the action in it, not a headline
block.
