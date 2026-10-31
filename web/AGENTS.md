# Frontend components

The root `components.json` configures shadcn/ui with Radix Maia, Phosphor icons,
and the existing navy/blue palette. Run the CLI from the repository root.
`pnpm exec shadcn info --json` shows the installed components and resolved paths.

## Component ownership

- `src/components/ui/` contains the shadcn source and our product variants.
- `src/shared/ui.tsx` and `src/shared/form.tsx` preserve existing feature APIs.
  Shared `Card` includes horizontal padding for its direct children; new composed
  cards should import the primitive and use its header, content and footer slots.
- `src/styles.css` owns semantic colors, typography, radius and dark mode.
  Use `cn` for class merging and variants for appearance. Keep `className` for layout.
- Forms compose `FieldGroup`, `Field`, labels and errors. Use `FieldSet` and
  `FieldLegend` for related inputs. The shared `Field` keeps `className` on its wrapper.

## Product requirements

- Every button size and text input has a minimum 44px target. Small buttons reduce
  horizontal padding, not the target height. Buttons default to `type="button"`;
  form submission must be explicit.
- `--input` is the strong control border; `--input-surface` is the subtle fill.
  Preserve visible keyboard focus and field-error associations in both themes.
- Badge variants retain neutral, success, warning, info and destructive meanings.
  A held payout is not a completed payment. Status text must stay visible.
- Payment tables keep their local compact spacing. Shared cards use Maia spacing.
- Native review dialogs keep their snapshot, stale-review, cancellation and focus
  behavior. Replacing a dialog requires the relevant payment-review regressions.

## Updating components

Use `pnpm exec shadcn docs <component>` before composing a new primitive. Preview
updates with `pnpm exec shadcn add <component> --dry-run` and `--diff <file>`;
merge upstream changes while retaining the product requirements above.

Run `pnpm typecheck`, `pnpm test`, and the affected offline browser suites.
Root `AGENTS.md` governs money-path changes and live-system actions.

## Prototype flows

- Organize each view around one decision, its relevant context, and the resulting outcome.
  Put the review context before the action in the mobile document order.
- Public pages explain each workflow and its status without simulated execution or approval.
  Preserve legacy example links as static area overviews and keep the public import boundary
  free of private reads and evidence.
- Use a visible single-selection ToggleGroup for short option sets, and NativeSelect
  for longer native choices. Required selections must not clear on a repeated click.
- Keep status badges short; put full explanations and provider codes in wrapping text.
  Native disclosures use 44px summaries. Supporting cards may use `size="sm"`.
- Live walkthroughs follow the exact returned payment or confirmed plan identifier.
  Never choose the newest record as a substitute, or infer settlement from UI progress.
  Preserve mounted confirmations and stream state through observation changes.
