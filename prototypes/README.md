# Labelling screen prototypes

Three standalone HTML files for the collaborator labelling screen. Open any of them directly in a
browser (`file://`, no server, no network, no build step). Each has inline CSS and one classic inline
`<script>`, inline mock data, and a "Prototype notes" footer below the screen with the design bet and
the key map. Reload resets everything; nothing is saved anywhere.

| File | Layout | Mock data |
| --- | --- | --- |
| `labeller-a.html` | focus card | the 9 sentiment records (`examples/annotation/queue.jsonl` + `schema.yaml`), 7 proposals (one deliberately invalid), 3 records already labelled |
| `labeller-b.html` | queue list + detail | same as A |
| `labeller-c.html` | keyboard line | the 5 expense records (`queue-multispan.jsonl` + `schema-multispan.yaml`, two span fields), plus the sentiment data on `d`; no proposals |

All three share the same behaviour underneath, so the comparison is about layout and flow, not
features. The shared behaviour follows `quet annotate` and `docs/contract.md`:

- **Offsets** are Unicode code points, `end` exclusive. The readout always shows `"text" [start,end)`.
  The 🍜 in `rv-008` counts as one.
- **Mouse.** Click a word to select it. Drag to select a range (both ends snap outward to whole words).
  Double-click snaps to a word. `m` (or the snap button) switches the mouse to character precision, which
  you need for CJK text: a run of Japanese letters is one "word". Leading and trailing spaces are trimmed.
- **Keyboard span mode** (`x`) follows Quet: the selection starts on the existing span or the first
  word; `←`/`→` (`h`/`l`) move, `shift+←`/`shift+→` (`H`/`L`) extend, `w`/`b` whole words, `W`/`B` extend by
  word, `0`/`$` ends, `enter` accepts (refused on leading/trailing space), `n` nulls, `esc` cancels.
- **Saving** runs the same rules as `normalizeLabel`/`validateLabel`: `skipped` clears type and spans, a
  `null_for_types` type forces its span to null, span statuses default to the first one listed. The saved
  label is shown in the footer as the exact wire JSON.
- **One deliberate difference from Quet:** `complete` is refused while a span is *unmarked* ("click the
  text, or press `n` if there is none"). Quet would save an unmarked target as `null`, which is easy to do
  by accident for someone who forgot to mark it. `uncertain` and `skipped` are not gated.
- **Undo** (`z`) restores the previous label of the last saved record and goes back to it, repeatedly.
  Moving away from a record with an unsaved draft discards the draft and says so.
- **Proposals** (A and B) show in a dashed block titled "Proposal — not accepted" with status, type, span,
  confidence and reason, plus `✓ matches current` or `⚠ invalid: …`. `p` accepts (and can be undone), `P`
  loads it into the draft without saving.

Things to try in every prototype: `1` then `enter` on a fresh record; click a word and press `s`;
`z` after a save; `?` for the help overlay.

## A — focus card

**Design bet.** The collaborator's job is reading one sentence and pointing at part of it, so the text is
the hero (36px serif, centered in a big card) and everything else is quiet. All actions live on one narrow
palette to the right that never moves: numbered type buttons with the type's description underneath, then
three big save buttons. A grey hint line under the span readout always says what is still missing
("pick a type", "mark the target", "press enter"). A proposal sits in its own dashed amber block under the
text so it can never be mistaken for the draft. Pace is "one at a time, deliberately", with the least
possible competing information.

| Key | Action |
| --- | --- |
| `1`–`4` | set type (schema order) |
| `enter` / `u` / `s` | save complete / uncertain / skipped |
| `x`, then `←` `→` `h` `l` `H` `L` `w` `b` `W` `B` `0` `$` | mark the span with the keyboard; `enter` accept, `esc` cancel |
| `n` | null target (no target) |
| `j` `↓` `→` / `k` `↑` `←` | next / previous record |
| `]` / `[` | next / previous unlabelled record |
| `p` / `P` | accept proposal / load proposal into draft |
| `z` | undo |
| `esc` | discard unsaved draft |
| `m` | mouse snaps to words / characters |
| `?` | help overlay |

**Feedback wanted.**
- Is the text big enough and the palette discoverable, or would you rather have the types under the text?
- After saving, the card jumps to the next unlabelled record. Does that feel right, or do you want to
  stay on the record and press `j`?
- Does the dashed proposal block read as "not mine yet" at a glance? Is `p` too easy to hit?
- Is the "complete needs a marked span or `n`" rule helpful or annoying?
- Does the card feel too sparse for hundreds of records a day?

## B — queue + detail

**Design bet.** Throughput people want to watch the pile shrink and to jump around. The whole queue is a
dense table on the left (tick, number, text, the label you gave it, its span, or a `◇ proposal` marker if
you have not labelled it yet) and never scrolls away. The right pane is a compact form for the current
record. Filters in the header (and `f`) re-sweep just the uncertain or skipped records, and a freshly saved
row flashes green and ticks itself. It trades A's calm for orientation: progress, history, and cheap
random access.

| Key | Action |
| --- | --- |
| `1`–`4` | set type |
| `enter` / `u` / `s` | save complete / uncertain / skipped |
| `x`, then movement keys | mark the span with the keyboard; `enter` accept, `esc` cancel |
| `n` | null target |
| `j` `↓` `→` / `k` `↑` `←` | next / previous record **in the filtered list** |
| `]` / `[` | next / previous unlabelled record |
| `f` | cycle list filter: all, unlabelled, complete, uncertain, skipped |
| `p` / `P` | accept proposal / load proposal into draft |
| `z` | undo |
| `esc` | discard unsaved draft |
| `m` | mouse snaps to words / characters |
| `?` | help overlay |

**Feedback wanted.**
- Is the always-visible queue reassuring or just noise next to the text?
- Is the text (24px) big enough, given the list competes for width?
- Do the filter chips and `f` solve "I want to revisit my uncertain ones"? Are the counts in them useful?
- Is the type/target summary per row the right amount of information? What else would you want in a row?
- Would you use clicking rows to jump, or only `j`/`k`/`]`?

## C — keyboard line

**Design bet.** For someone doing hundreds a day every pixel of chrome is a cost, so there is none: no
panels, no card, dark and monospaced. The screen is the record, one row per span field, the type chips with
their number keys, and a single **prompt line** that always shows the entire draft
(`❯ expense  target Vinamilk  value 500k·complete  ⏎ complete  u uncertain  s skip`), with a "next:" line
for what is still missing. A row of dots shows the whole queue's progress. The mouse is only for pointing at
words: after marking a span the active field jumps to the next unmarked one, so a typical record is
*click, click, `1`, `enter`*. The multi-span rules are shown rather than explained: `3` (transfer) strikes
through the counterparty row, moves to `value`, and refuses a selection on `target`.

Multi-span specifics: `tab` / `shift+tab` switch the active field (also inside `x` mode, keeping the
selection), `c` cycles the active field's span status (`value`: complete → uncertain, shown `(default)`
until you set it), `n` nulls only the active field, a field keeps its status even when its span is null, and
choosing a type that is null for a field clears it (leaving that type makes the field unmarked again).
`d` swaps to the single-span review data so you can see the same screen with one field.

| Key | Action |
| --- | --- |
| `1`–`3` | set type (expense / income / transfer) |
| `enter` / `u` / `s` | save complete / uncertain / skipped |
| `tab` / `shift+tab` | next / previous active span field |
| `x`, then movement keys | mark the active field with the keyboard; `enter` writes to it, `esc` cancels |
| `n` | null the active field |
| `c` | cycle the active field's span status |
| `j` `↓` `→` / `k` `↑` `←` | next / previous record |
| `]` / `[` | next / previous unlabelled record |
| `z` | undo |
| `esc` | discard unsaved draft |
| `m` | mouse snaps to words / characters |
| `d` | switch mock dataset (expenses / reviews) |
| `?` | help overlay |

**Feedback wanted.**
- Is the single prompt line a clear picture of the draft, or does it duplicate the field rows?
- Does auto-advancing the active field after marking a span help, or is it surprising? (Double-click on a
  word keeps the field it started on.)
- Is dark monospace chrome acceptable for non-technical collaborators, or does it feel like a developer tool?
- Is the locked, struck-through `target` for a transfer clear enough? Should `tab` skip locked fields?
- Do you want proposals in this layout too (they are not mocked here)?

## Comparing

Try the same five records in each, with and without the mouse. Useful questions across all three: how many
actions per record, how obvious the next step is, how easy it is to go back and fix one, and what you would
want to see differently when you have done 300 of them.
