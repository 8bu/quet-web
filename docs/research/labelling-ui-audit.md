# Labelling screen audit (hands-on, first-time collaborator)

Scope: the live labelling screen `https://quet.8bu.dev/p/gidi-hv01-test` (TEST project, 150 real gidi notes, schema
[`annotation-v2.quet.yaml`](../../../gidi/configs/annotation-v2.quet.yaml): 8 types, spans `target` + `value`).
Driven with the omp `browser` tool in headless Chromium at 1280x900 (main), 1440x900 and 390x844. Labelled 14 notes
mouse-only and keyboard-only, plus revise / undo / skip / error probes. App source cited as `file:line` in this repo;
screenshots in [`audit-img/`](audit-img/) (cited by file name).

Per the user's reply to this audit ("all six problems": too much on screen, fiddly span marking, slow type picking,
unclear saved-vs-draft, confusing keys, looks bad) and the reference tool they like (Label Studio), each
recommendation at the end says where the Label Studio pattern is supported or contradicted by what I measured.

## 0. Method and honest limits

- **Driver, not a human.** The browser tool fires events in milliseconds, so wall-clock times of my runs are
  meaningless as human speed. What I *measured*: page ready 436 ms after `goto`; save round trip (`PUT label`) 158 ms
  (instrumented `fetch`). Human-time figures below are **keystroke-level-model estimates [INFERENCE]** using the
  Card/Moran/Newell operator times (K = 0.28 s, pointing+click ≈ 1.3 s, M = 1.35 s)
  ([KLM, CACM 1980](https://cacm.acm.org/research/the-keystroke-level-model-for-user-performance-time-with-interactive-systems);
  [summary](https://en.wikipedia.org/wiki/Keystroke-level_model)); scroll = 0.8 s is my assumption.
- **I read the source before running** (`src/web/label.ts`, `public/label.css`, `public/label.html`, `docs/contract.md`
  "Labelling screen"), so I knew the key map; a true first-timer would be slower. Counts below are therefore a *floor*.
- I am not a first-timer, but I marked the screen "as a first-timer would meet it": I did not open help before the
  first label, and I list what a first-timer would have to read (section 3).
- Counts: **click** = one mouse click/tap; **drag** = press-move-release; **scroll** = one wheel scroll to reach a
  control; **key** = one key press. "Ideal" = shortest path I found; "observed" = what I really typed including mistakes.
- Labels written to the TEST project (allowed). Password never recorded.

## 1. Step counts per scenario (1280x900)

### Mouse only

| # | Scenario (note) | Ideal | Observed | Notes |
|---|---|---|---|---|
| M1 | Both spans (#1 `ve may bay vietjet tet 2tr9`) | 4 clicks + 1 scroll (type, 2 words, scroll, complete) | same | Save-as is ~1,320 px down; see F1 |
| M2 | Null target (#2 `nhan tien freelance web 6tr`) | 4 clicks + 2 scrolls (scroll up first because the previous save left the page scrolled down) | same | `no target` button is inside the card |
| M3 | Uncertain (#3 `no tien hui thang nay 1tr`) | 4 clicks + 2 scrolls | same | `uncertain` is 1 click but needs the same scroll |
| M4 | Wrong-span trap + fix (#4 `mua sách 215.000 fahasa`) | 3 clicks + 1 drag + 2 scrolls | **9 clicks + 1 drag + 2 scrolls** | tried the amount first (Target was active), then the click on the dotted amount marked `"."` then `"215"`; fix needs Target row, word, Value row, drag (screens 09, 10, 11) |
| M5 | Undo (#4 right after saving) | 1 click (header `Undo`) | 1 click | whole label gone, record is blank again (re-do costs M4 again; screen 12) |
| M6 | Transfer via queue (#10 `chuyển tiền ví sang ngân hàng 420k`) | 6 clicks + 1 scroll (Queue, row, close drawer, type 7, word, complete) | **10 clicks + 1 scroll** | I deliberately tried to mark a target on a transfer (+3 clicks: Target row, word, word while locked); shows the locked-field feedback (screens 15, 16) |
| M7 | Skipped (#11) | 1 click + 2 scrolls (scroll up to read the note, back down to `skipped`) | same | saved instantly, no confirm, toast says "saved · z undo" |
| M8 | Go back to a labelled note | 2 clicks + 1 scroll (`previous` ×2) | same | |

Ideal mouse per fully labelled note (type + 2 spans + save) ≈ **4 clicks + 1–2 scrolls**; with a note like
`215.000` it becomes ≈ 3 clicks + 1 drag + 2 scrolls.

### Keyboard only

| # | Scenario (note) | Ideal keys | Observed | Notes |
|---|---|---|---|---|
| K1 | Both spans (#6 `Quang còn nợ mình 1tr`) | `4 x ⏎ x $ b ⏎ ⏎` = **8** | 8 | `x` always starts on the first word; `$ b` is the only short route to the last word and is undiscoverable (F9) |
| K2 | Transfer (#5, #12) | `7 x $ b ⏎ ⏎` = **6** | 6 | target auto-locks; first open field is value |
| K3 | Null target + value (#8, #9) | `6 n x $ b ⏎ ⏎` = **7**; `1 n x w w w ⏎ ⏎` = **8** | 7, 8 | |
| K4 | Dotted amount, both spans (#4) | 13 (`1 x w w w w ⏎ x w w W ⏎ ⏎`) | **26** | I pressed `$` for the target and got the single letter `a`; then `W` overshoot, `B/H/L` to repair, `Esc`, `Tab`, `x`, … (screens 20-23) |
| K5 | Dotted amount + refund (#14 `hoàn tiền đơn lazada 189.000đ`) | 13 (`8 x w w w ⏎ x $ b b W ⏎ ⏎`) | 13 | `b b W` to cover `189.000đ` because the dot splits words |
| K6 | Uncertain record + uncertain span (#7) | 8 (`1 n x w w W ⏎` then `c`, `u`) | 13 | `c` makes the *value span* uncertain, `u` saves the *record* uncertain (two meanings, F12) |
| K7 | Skipped (#13) | **1** (`s`) | 1 | no confirm, toast says "saved" |
| K8 | Undo | **1** (`z`) | 1 | restores a *blank* record; the 13 keystrokes of K5 must be re-typed |
| K9 | Revise a wrong span on a labelled note (#7, from #8) | ~9 [INFERENCE] | **18** | `k`, `x` starts on **Target** (the already-null field), `Esc`, `Tab`, `x`, `w w` (marked `000`), re-`x`, `b W`, ⏎, ⏎; after saving, the app jumped to the next *unlabelled* note, not back (screens 25-27) |

Ideal keyboard per note ≈ **6–8 keys** (13 for a dotted amount); mouse ≈ 4 clicks + 1–2 scrolls.

### KLM time estimate [INFERENCE]

Execution only (no reading/deciding), 1.3 s per click, 0.8 s per scroll, 1.5 s per drag, 0.28 s per key + 0.4 s homing:

| Scenario | Mouse | Keyboard |
|---|---|---|
| Both spans | 6.0 s | 2.6 s (8 keys) |
| Transfer | 8.6 s (incl. queue jump) / ~5.4 s from the card | 2.1 s |
| Dotted amount (ideal) | 7.0 s | 4.0 s (13 keys) |
| Dotted amount (observed) | 14.8 s | 7.7 s (26 keys) |
| Skip | 2.9 s | 0.7 s |

Adding 3 decisions × M (4 s) the 150-note run is ≈ **26 min mouse vs ≈ 17 min keyboard** at best, plus reading time and
real mistakes. The dominant mouse costs are not clicks but the two scrolls per note forced by the layout (F1).

## 2. Measurements on the default screen

Counted on the unlabelled default state at 1280x900 (script in-page, visible elements only):

| Metric | Value |
|---|---|
| Interactive controls (buttons + link) | **26** (22 inside the 900 px viewport) |
| `<kbd>` hints | **25** (18 in viewport) |
| Text-bearing elements | **104** |
| Words on screen (page / in viewport) | **544 / 491** (record text is 5 words) |
| Font sizes in use | 11, 12, 13, 14, 15, 17, 36 px; **42 text elements are ≤12 px** |
| Palette height | **1,481 px** (viewport 900 px); document height 1,605 px |
| Type definitions | 222 words; `transfer` alone is **108 words, 20 lines, 478 px** (rows range 73-478 px) |
| Header at 1280 px | 70 px with 0 labelled → **88-105 px** as chip counts widen (wraps to two rows) |
| Distance from record text to `complete` button | 1,322 px at 1440x900 (`.sbtn.st-complete` top) |

Screens: [`03-default-1280.png`](audit-img/03-default-1280.png) (what the user sees),
[`03b-default-1280-fullpage.png`](audit-img/03b-default-1280-fullpage.png) (the whole page), [`40-viewport-1440.png`](audit-img/40-viewport-1440.png).

### What a first-timer must read before the first label

1. The record (5 words).
2. The hint line (8 words) and the two span rows - whose **definitions are truncated to ~24 characters**
   (`Minimal explicit expression for…`, `The monetary amount: the mi…`; CSS `.sd {max-width: 24ch; text-overflow: ellipsis}`,
   `public/label.css:78`). The real definitions (target 79 words, value 73 words incl. the decisive rules - "Never items,
   dishes, activities…", "Exclude quantities…") exist only in the `title` tooltip.
3. All 8 type definitions (222 words) because the type picker is the largest thing on screen and the only definition
   text shown.
4. Optionally the help sheet (327 words, includes "code points", "`[22,31)` offsets" and a comparison with "the Quet
   terminal annotator").
5. Status definitions (complete 11 / uncertain 22 / skipped 26 words) exist only as tooltips on the Save-as buttons that
   are off-screen.

So the screen shows ~220 words about *types* (a choice made in one keypress) and ~0 visible words about *spans* (the part
that causes the mistakes in section 5). That is inverted information hierarchy.

## 3. Nielsen heuristics

Reference: [NN/g, 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/). Severity per finding
in section 4.

| Heuristic | Verdict | Evidence |
|---|---|---|
| 1 Visibility of system status | Mixed | **Good**: toast on every mark (`Target "vietjet" [11,18)`), live `Draft:` line, chip `Draft · not saved` / `Saved ✓ complete · edited, not saved`, queue row labels. **Bad**: toast fades in 4.2 s; draft line and Save-as are off-screen; saved-skipped note shows `Target: not marked yet`/`no type yet` like a blank record (screen 18); header wraps and shifts; the chip is 13 px at 3.7:1 contrast. F3, F5, F10 |
| 2 Match system/real world | Weak | jargon in the primary UI: `snap: words`, `select with keys`, offsets `[11,18)`, `null`, `repayment_in`, `span status`, "Draft", `.sv` mono font; `uncertain` means two things (F12). Vietnamese amounts (`215.000`, `7,2tr`, `10 triệu`) do not match the app's "word" |
| 3 User control and freedom | Mixed | Undo exists and is repeatable (good) but restores a blank record, not the draft; navigating away silently discards the draft (`unsaved draft discarded`, `label.ts:895`); `Esc` has three meanings (cancel selection / discard draft / close drawer) |
| 4 Consistency and standards | Weak | `Enter` = accept selection *and* save as complete (double-Enter muscle memory, `label.ts:1365`); `Tab` is hijacked (never moves browser focus); `$` selects the last *character* (vim) while `W/B/H/L` are vim cases; `no target` button silently relabels to `no value` when the active field changes |
| 5 Error prevention | Weak | wrong-field write is silent (F4); a click on `215.000` silently stores `"215"` or `"."` (F2); the same text can be in both spans; one-click `skipped` with no confirm next to `complete`; a saved label can retain a hidden `uncertain` value status (screen 27) |
| 6 Recognition vs recall | Weak | 25 key hints but no mnemonic (`x` select, `c` status, `m` snap, `\` queue, `[`/`]`); the idioms that matter (`$ b`, `W`) are not shown; span rules only in tooltips |
| 7 Flexibility/efficiency | Good ceiling | 6-8 keys per note is excellent once learned; mouse path wrecked by scrolling; no touch accelerators |
| 8 Aesthetic and minimalist | Poor | 26 controls, 25 kbd chips, 544 words, 7 font sizes, 478 px of one definition, 540 px-tall card with ~120 px empty band above the spans (screen 03). Nothing is hidden by default; everything competes |
| 9 Recognise/diagnose/recover errors | Mixed | **Good**: specific refusal messages (`value isn't marked — click the text, or press n if there is none`; `target must be null for transfer`). **Bad**: `Failed to fetch` on offline save (screen 34) with no retry guidance; `target must be null for transfer — tab switches field` is shown to mouse/touch users; `p` without proposals is silent; dropped keys while saving (F11) |
| 10 Help and documentation | Weak | `?` sheet is 327 words with developer vocabulary; the span rules the collaborator needs most are not in the help at all |

## 4. Findings ranked by severity

### Blocker

**F1. The Save-as buttons and draft are off-screen; the page stays scrolled after saving (mouse/touch).**
`.palette` is 1,481 px tall (8 long definitions; `transfer` 478 px); `Save as` starts at ~1,320 px; the palette is `position:
sticky` but as tall as its grid row, so it never sticks (`public/label.css:109`). Mouse path needs a scroll to save and a
scroll back to read the next note; after `click complete` the scroll position stays (scrollY 686) and the new record's text is
out of view while the left half of the screen is blank. Evidence: [03b](audit-img/03b-default-1280-fullpage.png),
[06](audit-img/06-mouse-scrolled-to-save-as.png), [07](audit-img/07-mouse-after-save-scroll-stays.png); 1440x900 gives the same
layout ([40](audit-img/40-viewport-1440.png)). Costs 2 extra scrolls per note (≈ 1.6 s × 150 = 4 min [INFERENCE]) and hides the
only prominent "what happens next" control.

**F2. Click-snap splits Vietnamese amounts, and a click silently saves a wrong span.**
Word snapping uses runs of letters/digits (`wordRanges`, `src/shared/schema.ts:146`) so `.` and `,` split tokens: click on
`215.000` stores `"215"` (clicking the dot stores `"."`), `7,2tr` stores `"7"`, `10 triệu` stores `"10"`. Mouse needs a drag over
the whole amount; keyboard needs `b b W`. In the real queue **12/150 notes (8 %) have a separator inside the amount** and **20
more (13 %) have number + unit words** (`10 triệu`, `300 nghìn`, `1 trieu`), so ≥ **32/150 (21 %)** values cannot be marked with one
click. Nothing warns the span is part of a number. Screens: [09](audit-img/09-mouse-wrong-field-written.png),
[10](audit-img/10-mouse-both-wrong.png), [11](audit-img/11-mouse-drag-amount-with-dot.png), phone tap [44](audit-img/44-mobile-save-as.png)
(`"189"`). Blocker for **data quality**, because the saved label is schema-valid and wrong.

**F3. On a phone the span rows break and the header eats the screen.**
At 390x844 each span value renders one character per line (`n o t m a r k e d y e t`, rows ~300 px tall), the sticky
header is **236 px** (28 % of the screen), the page is 2,941 px tall, `types` start at 1,615 px and `complete` at 2,681 px, 13
buttons are < 44 px tall (WCAG 2.5.8 AA minimum is 24 px with spacing, AAA 44 px;
[WCAG 2.2 SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)), and 25 `<kbd>` key hints are shown
on a device with no keyboard. A phone run (type → text → spans → save) = 4 taps + 3 long scrolls. Screens:
[41](audit-img/41-mobile-390-default.png), [41b](audit-img/41b-mobile-390-full.png), [42](audit-img/42-mobile-types-scrolled.png),
[44](audit-img/44-mobile-save-as.png). Blocker **if** collaborators use phones; cannot tell from the repo [INFERENCE].

### Major

**F4. Which field a click/drag writes to is a hidden mode (the "active field").**
Documented as intended (`docs/contract.md` "Labelling screen", last bullet) but in practice: (a) a first-timer clicks the amount
first and writes it into **Target** (screen 09); (b) the next click then fills Value, giving both fields wrong; (c) fix needs
Target row, word, Value row, word (M4: 9 clicks); (d) on a **revisit** the active field is always Target
(`firstOpenField`, `label.ts:301`), so clicking `2tr9` to fix the value **overwrote the saved target `vietjet` with `2tr9`** and the
app displayed both as `2tr9` with chip `Saved ✓ complete · edited, not saved`
([35](audit-img/35-revise-click-overwrites-target.png)); (e) the same text can be saved in both spans. The only mode cue is a
12 px swatch outline plus a 1 px row border; on a revisit the hint (`saved · j next …`) does not name the field.

**F5. Draft vs saved vs "what Enter does" is spread over six places.**
State signals: chip (top-right, 13 px, 3.7:1), hint line, toast (4.2 s), draft line (bottom of palette, off-screen), span rows,
queue glyphs. Behaviours that surprise: `Enter` after `x` accepts the selection, a second `Enter` saves (I pressed Enter twice in
every run); a save jumps to the next *unlabelled* note, so revising a labelled note and saving **leaves it** (K9); clicking a
queue row or `j/k` **discards the draft** with an after-the-fact toast (`unsaved draft discarded`; confirmed on `j`); undo restores a
**blank** record, not the draft; `skipped` saves with toast "saved"; a saved-skipped note displays `not marked yet` on both
spans and `no type yet` ([18](audit-img/18-mouse-back-on-skipped-record.png)). Good bits to keep: the `edited, not saved` suffix
and `Draft · not saved` chip.

**F6. The definitions are inverted: 222 words of type text always shown, the span rules hidden.**
See section 2. First-timer cannot read what a `target` is without hovering a 24-character stub; mobile has no hover.

**F7. Keyboard scheme needs recall and is partly vim.**
25 key hints, but the idioms that work are undocumented: `x` starts at the **first word** (or the existing span), `$` selects
the last **character** (`a`, `r`, `0`, not the word; Enter accepts it silently), `w` splits at punctuation (`400.000` = `400`,
`000`), `W/B` move by whitespace WORD with vim end/start semantics (`B` from the end of `fahasa` gave `"215.000 f"`). Help text
([29](audit-img/29-help-overlay.png)) explains `0/home and $/end ends` but not that the result is one character. Esc: cancel
selection / discard draft / close drawer. `u` saves the record uncertain, `c` toggles the value span, `Tab` switches field but
never moves browser focus (below). 26 keys vs 13 ideal on one note (K4).

**F8. Header layout shifts and the drawer covers it.**
With ≥ 10 labelled notes the chips wrap and the header grows from 70 to 88-105 px at 1280 (progress bar shrinks, content moves
down 18-35 px; screens [16](audit-img/16-mouse-transfer-target-forbidden.png), [32](audit-img/32-hover-single-character.png)). At
≥ 1180 px the queue drawer (z-index 25 over header z-index 20) hides brand, `13 / 150` and half of the chips and squeezes
the record card so the span value wraps four lines ([14](audit-img/14-queue-row-clicked.png)).

**F9. Contrast.** `--mute #7a7466` is 4.12:1 on the page background and 4.19:1 on span rows (WCAG 1.4.3 needs 4.5:1,
[ref](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)); the 11 px `no target` tag is 3.9:1 and the saved
chip 3.73:1. Span definitions (12 px) and queue labels (12 px) use that grey. Computed from `public/label.css:3`.

### Minor

- **F10. Faint single-character hover.** `.c:not(.sp):hover` highlights **one letter** at 13 % alpha ([32](audit-img/32-hover-single-character.png)); a click selects the whole word/token, so the affordance lies.
- **F11. Keystrokes are dropped while saving.** While the 158 ms `PUT` runs `busy` is true and keys are ignored without a message (`label.ts:1352`); I pressed `1` immediately after `Enter` (no pause) and it was lost. Fast typists will lose the first key of the next record.
- **F12. Two "uncertain".** Record status (`u`) and value span status (`c`, row text `complete (default)`) share a word; `c` leaves a hidden `uncertain` span status on a record saved as complete (K6/[27](audit-img/27-kbd-revised-value-uncertain-status-kept.png)).
- **F13. `no target` button changes name with the active field.** After the first click the same button is `no value` (screen 08); a second click on the same spot nulls the value.
- **F14. Locked target row is clickable and active.** Clicking the struck-through Target on a transfer makes it active and a following word click is refused with `…tab switches field` ([16](audit-img/16-mouse-transfer-target-forbidden.png)).
- **F15. Null vs unmarked look alike.** `Target: null` and `not marked yet` are the same grey mono text; the draft line differentiates (`no target`).
- **F16. Offline error is raw.** `Failed to fetch` toast + hint, no "not saved, retry" ([34](audit-img/34-error-save-offline.png)); the draft is kept (good).
- **F17. Accessibility.** All palette/span/queue buttons have `tabindex=-1` and the page eats Tab, so Tab never moves browser focus (I verified `document.activeElement` stays `BODY`); header buttons keep the browser's default focus ring only (no `:focus-visible` rules in `label.css`); record text is a row of `<span>`s with an `aria-label` but no selection semantics; hover-only tooltips. Details in [33](audit-img/33-focus-ring-header-button.png).
- **F18. Help sheet.** 327 words, developer vocabulary, `code` blocks wrap mid-word (`nu / ll`, `dù / ng`) ([29](audit-img/29-help-overlay.png)); no mention of the amount idioms.
- **F19. Layout waste.** The card has `min-height: 540px` and ~120 px of empty band between record text and span rows; a 36 px serif record is good, but the status/save controls are 800+ px away.
- **F20. No visible undo state.** `Undo` is always enabled; `nothing to undo` appears only as a toast.

### What works and should be kept

Live toast per mark; the `Draft:` summary line; `Draft · not saved` / `Saved ✓ · edited, not saved` chips; auto-advance to
the next unmarked field; forbidden target auto-null for `transfer` with strike-through and explanation; precise refusal
messages for `Enter`; repeatable undo; progress count with complete/uncertain/skipped/left; per-row labels in the queue
drawer; colour-coded spans with distinct hue per field; type keys `1-8` shown on every type.

## 5. Evidence log (key states)

| State | File |
|---|---|
| Login/projects | [01](audit-img/01-login.png), [02](audit-img/02-projects.png) |
| Default screen, viewport / full page | [03](audit-img/03-default-1280.png), [03b](audit-img/03b-default-1280-fullpage.png) |
| Both spans (mouse), scroll to Save-as, after save | [05](audit-img/05-mouse-both-spans-marked.png), [06](audit-img/06-mouse-scrolled-to-save-as.png), [07](audit-img/07-mouse-after-save-scroll-stays.png) |
| Null target | [08](audit-img/08-mouse-null-target-set.png) |
| Wrong-field and dotted amount | [09](audit-img/09-mouse-wrong-field-written.png), [10](audit-img/10-mouse-both-wrong.png), [11](audit-img/11-mouse-drag-amount-with-dot.png) |
| Undo | [12](audit-img/12-mouse-after-undo.png), [28](audit-img/28-kbd-after-undo.png) |
| Queue drawer | [13](audit-img/13-queue-drawer-open.png), [14](audit-img/14-queue-row-clicked.png) |
| Transfer, locked target | [15](audit-img/15-mouse-transfer-selected.png), [16](audit-img/16-mouse-transfer-target-forbidden.png) |
| Skip and revisit skipped / labelled | [17](audit-img/17-mouse-before-skip-click.png), [18](audit-img/18-mouse-back-on-skipped-record.png), [19](audit-img/19-mouse-back-on-labelled-transfer.png) |
| Keyboard select mode, extend, fix, ready | [20](audit-img/20-kbd-x-select-mode-start.png), [21](audit-img/21-kbd-extending-amount.png), [22](audit-img/22-kbd-fixing-target.png), [23](audit-img/23-kbd-before-save.png), [24](audit-img/24-kbd-both-spans-ready.png) |
| Revising a wrong span with keys | [25](audit-img/25-kbd-revising-wrong-span.png), [26](audit-img/26-kbd-revised-ready.png), [27](audit-img/27-kbd-revised-value-uncertain-status-kept.png) |
| Help | [29](audit-img/29-help-overlay.png) |
| Errors | [30](audit-img/30-error-enter-without-type.png), [31](audit-img/31-error-target-unmarked.png), [34](audit-img/34-error-save-offline.png) |
| Hover / focus | [32](audit-img/32-hover-single-character.png), [33](audit-img/33-focus-ring-header-button.png) |
| Revisit overwrites target | [35](audit-img/35-revise-click-overwrites-target.png) |
| 1440 / phone | [40](audit-img/40-viewport-1440.png), [40b](audit-img/40b-viewport-1440-full.png), [41](audit-img/41-mobile-390-default.png), [41b](audit-img/41b-mobile-390-full.png), [42](audit-img/42-mobile-types-scrolled.png), [43](audit-img/43-mobile-after-target-tap.png), [44](audit-img/44-mobile-save-as.png) |

## Implications for quet-web

Ranked. "LS" = Label Studio. LS claims below are limited to what the
[Label Studio labeling guide](https://labelstud.io/guide/labeling) and
[Labels tag](https://labelstud.io/tags/labels) state (select a label, click/highlight the text, "your changes save
automatically" for regions, click **Submit** to commit and move on; per-label `alias`/hotkeys; a hotkeys page) and
[hotkeys guide](https://labelstud.io/guide/hotkeys); everything else about LS is for the ToolPatterns report.

1. **Everything needed to finish one note must fit one 900 px screen with no scrolling (fixes F1, F6, user problems 1, 3, 4).**
   Move the 8 types into a compact two-row chip bar *above* the record text (name + key only), put the span rows and a single
   **Save / Skip / Unsure** bar directly under the text, show the type definition only for the hovered/focused/selected type
   (popover or one-line gloss; keep the 108-word `transfer` rule out of the default view). Budget: one record, one type row, two span
   rows, one action bar, ≤ 12 controls, ≤ 120 words. *LS: supported* - LS keeps the label set as one compact strip and
   Submit as one explicit control; the audit shows our side-panel is exactly what breaks (palette 1,481 px vs 900 px).

2. **Make the span model visible and unambiguous, and never overwrite a saved span by accident (F4; problem 2).**
   Put the two span "pills" (Target amber, Value teal, each with the key that picks it) *on the text line*; the active one wears
   the same colour as the selection that will appear; on revisit default to the **first unmarked** field, or none (ask), never
   Target-by-default; reject writing identical or overlapping text into both fields (inline message, not a toast); clicking a
   *highlighted* span selects it for replacement, clicking plain text writes to the active pill only. *LS: supported with a
   caveat* - LS's "pick a label, then highlight" is the same mode; our own contract adopted that and the audit shows the mode
   bites (M4: 9 clicks; revisit overwrite). So copy LS only together with a loud active-label cue and a per-label hotkey
   (LS labels take aliases/hotkeys per the Labels tag), and keep auto-advance since it saved clicks.

3. **Snap to whitespace-delimited tokens and trim trailing punctuation, not to letter/digit runs (F2; problem 2).**
   `215.000đ`, `7,2tr`, `1.450.000đ`, `4,5tr` (12 notes) must be one click; `10 triệu`/`300 nghìn` (20 notes) need a "extend to next
   token" gesture (shift-click or `→`). Add a guard: if a span ends or starts inside a digit run (`215` followed by `.000`) ask
   or extend automatically. Pre-select the money token as a *suggestion* for the Value pill (regex `\d[\d.,]*\s?(k|tr|triệu|nghìn|đ|d)?`)
   that the annotator confirms with one key; this removes the most frequent action. *LS: unverified here* - I did not verify how
   LS tokenises; do not copy its granularity without the ToolPatterns result.

4. **One explicit commit, one visible state (F5; problem 4).** Single status strip beside the Save bar: `Draft - not saved`,
   `Saved ✓ complete`, `Saved · edited, not saved`; `Enter` = **Save** only (selection is accepted on mouse-up or by `Space`),
   after a save always say `Saved → note 15` and keep the saved record reachable with `←`; revising a labelled note and saving
   should stay put (or return to where you were), not jump away; moving off a dirty draft keeps the draft (per-record
   in-memory draft) instead of discarding it; `z` restores the previous draft, not a blank note; `skipped` gets a visible banner
   state, not `not marked yet`. *LS: supported* - the guide's flow is region edits autosave, **Submit** commits and advances,
   and the status of the annotation is explicit; but LS's Update-in-place when revisiting contradicts our current "advance to
   next unlabelled after any save" and the audit (K9) shows ours is the surprising one.

5. **Cut the keyboard scheme to what a first-timer can guess (F7, F12; problem 5).**
   Keep `1-8` types, `Enter` save, `s` skip, `u` unsure, `z` undo, `←/→` previous/next. Replace the vim cursor (`x w b W B H L $ 0`)
   with token cursor: `x` or `Space` selects the first/nearest token for the active pill; `←/→` move by token, `⇧←/⇧→` extend;
   `$`/`End` must select the *last token*, never one character; `Tab` switches pill. Drop `m`, `c`, `\`, `` ` `` from the default
   chrome (move span status into the pill as a small toggle). Show only the 5-6 keys that apply *now* in the hint line, hide
   the other 19 `<kbd>` badges until `?`. Target: 6-8 keys per note (today 6-8 ideal, 13-26 when anything is off). *LS:
   supported* - LS exposes hotkeys per label plus a global map and a settings toggle (hotkeys guide), i.e. keys are shown per
   control and optional, not 25 always-on badges.

6. **Show span rules where the decision is made (F6, F18; problem 3).** One-line rule under each pill (`Target - counterparty only, not
   item/bill/channel`; `Value - number + unit, e.g. 215.000đ, 10 triệu`) plus `more` popover with the 79/73-word definitions;
   add a `short:` field to the schema for this (gidi YAML has none today). Same for statuses (22/26-word definitions now only in
   tooltips of off-screen buttons). Replace the 327-word help with a one-screen "first 3 notes" card.

7. **Make the phone layout a first-class one-screen flow (F3).** ≤ 48 px single-row header (`14/150` + queue), record text, two
   one-line pill rows, horizontal-scroll type chips, **fixed bottom Save bar**; hide `<kbd>` on `pointer: coarse`; every control
   ≥ 44 px; long-press/drag on text with `touch-action` only on the text. Fixes the one-character-per-line span value (the
   `flex:1; min-width:0` value cell loses to `max-width:24ch` description on narrow widths).

8. **Prevent silent bad labels (F2, F4, F12).** Inline validation before save, not a toast: both pills equal/overlapping; span is
   one punctuation char or digit-run fragment; Value span has no digit; target text equals a payment-channel/amount; `Complete`
   with a Value status of `uncertain` (hidden state) - show it as `complete, amount unsure` or force the choice.

9. **Stabilise the chrome (F8, F19).** Fixed 48 px header with `14/150` and one progress bar; counts collapse into a popover;
   queue as an overlay/side sheet that never covers the header or squeezes the card; remove the 540 px min-height gap.

10. **Look and accessibility pass (F9, F10, F17; problem 6).** Raise `--mute` to ≥ 4.5:1 (≈ `#6b6557` on the card; computed ratios in F9),
    drop sizes to four steps (record 36, body 15, label 13, hint 12 only where contrast passes), add `:focus-visible`, stop
    hijacking Tab (use a documented key for field switch, keep Tab for focus), make the hover target the *whole token*, add roles
    for the record text, make Undo disabled when empty, replace `Failed to fetch` with `Not saved - check your connection. Your
    draft is kept. Retry (Enter)`.

### Where the audit supports or contradicts the Label Studio pattern (summary)

| LS pattern the user likes | Audit evidence |
|---|---|
| Labels + Choices visible at once, compact | **Supported.** Our 1,481 px palette is the #1 blocker (F1). |
| Pick label then highlight text | **Supported with a condition.** It is the same mode quet already has; 2/4 mouse mistakes and the revisit overwrite come from it (F4). Needs a loud active-label cue and per-label hotkeys. |
| Region list shows what you marked | **Supported.** Our span rows play that role; they work (toast + draft are the best parts) but must sit next to the text. |
| Explicit Submit (Update when revisiting) | **Supported, and contradicts our auto-advance-to-unlabelled-after-any-save (K9) and silent draft discard.** |
| Hotkeys per label, optional | **Supported.** 25 always-visible key badges are a cost (F7, heuristic 8). |
| Word-level highlighting | **Not confirmed.** Vietnamese amounts with `.`/`,` and two-word amounts (21 % of this queue) break letter/digit-run snapping (F2); verify LS tokenisation before copying. |
| Desktop-first | **Not enough** for collaborators on phones: audit shows the current layout is unusable at 390 px (F3). |
