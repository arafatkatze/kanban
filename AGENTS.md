This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

---

Agent Client Protocol (ACP)
- ACP is a protocol that lets us interface with CLI agents like codex. When working on anything ACP related, you can use:
- .plan/docs/ACP-docs.md for all of ACP's documentation
- .plan/docs/ACP-SDK-notes.md for a reference to how the ACP SDK is implemented
- .plan/docs/ACP-reference-project.md for notes on ~/Repositories/kanban/vscode-acp, a client that implements ACP

web-ui Stack
- Kanban web-ui uses Palantir Blueprint v6 (`@blueprintjs/core`, `@blueprintjs/icons`, `@blueprintjs/select`) for all UI components and styling.
- Blueprint docs reference: `.plan/docs/blueprint-ui-docs.md`
- Blueprint source repo (for checking patterns, API, dark theme behavior): `~/Repositories/kanban-idea/blueprint/`

Blueprint styling mental model
- In a Blueprint app, component props ARE the styling system. `<Button intent="primary" variant="outlined" size="small" fill />` is the equivalent of writing CSS. Don't reach for CSS or inline styles for things Blueprint components already handle via props.
- The only custom CSS you should write is app-level layout glue that Blueprint has no component for (panel arrangements, sidebar widths, scroll containers). This lives in `globals.css` with `kb-` prefixed classes.
- Do NOT use Tailwind, CSS-in-JS, or any other styling system alongside Blueprint. They compete with Blueprint's dark theme system, reset/normalize, and spacing scale. Blueprint is the single source of truth for styling.
- When you need a color in CSS, use Blueprint's CSS custom properties (`--bp-palette-dark-gray-1`, `--bp-intent-primary-rest`, `--bp-typography-size-body-small`, etc.). Never hardcode hex values in CSS. The full list is in `node_modules/@blueprintjs/core/lib/css/blueprint.css` (search for `--bp-`).
- When you need a color in TSX for truly dynamic/computed values (drag-and-drop accent colors, conditional per-element coloring), use Blueprint's `Colors` constants from `@blueprintjs/core`.
- Default to inline `style=` for component-specific styles. Only extract a `kb-*` class into `globals.css` when the same styles are applied across multiple components, or when you need CSS features that inline styles can't express (pseudo-selectors like `:hover`, sibling selectors like `+`, attribute selectors like `[aria-expanded]`, or `oklch()` color functions). A class used by a single component is unnecessary indirection -- just inline it.
- Blueprint's spacing is a 4px base grid (`--bp-surface-spacing`).
- NEVER hardcode font sizes as pixel values. Use Blueprint's typography CSS variables: `--bp-typography-size-body-x-small` (10px), `--bp-typography-size-body-small` (12px), `--bp-typography-size-body-medium` (14px, the default), `--bp-typography-size-body-large` (16px). For code/monospace: `--bp-typography-size-code-small` (12px), `--bp-typography-size-code-medium` (13px), `--bp-typography-size-code-large` (14px). In CSS use `var(--bp-typography-size-body-small)`. In TSX, if you must set font size inline, still prefer not overriding the default (14px) at all -- Blueprint components already use the right size. If you need small text, apply `Classes.TEXT_SMALL` or use a CSS class with the variable.

Blueprint namespace (v6 = `bp6-`)
- Blueprint v6 uses the `bp6-` CSS namespace prefix. NEVER hardcode `bp5-` anywhere.
- Use the `Classes` constants from `@blueprintjs/core` instead of hardcoding class name strings. For example: `Classes.DARK` instead of `"bp6-dark"`, `Classes.TEXT_MUTED` instead of `"bp6-text-muted"`, `Classes.HEADING` instead of `"bp6-heading"`.
- If the `Classes` constant doesn't exist for what you need, check the Blueprint source at `~/Repositories/kanban-idea/blueprint/` to find the right approach.
- If you're unsure what namespace version is installed, check `node_modules/@blueprintjs/core/lib/esm/common/classes.js` for the actual `NS` value.

Dark theme
- The app runs in Blueprint dark theme. The `bp6-dark` class is on `<body>` in `index.html`.
- Blueprint's dark theme class only themes child Blueprint components. It does NOT automatically set background/text colors on plain HTML elements. You must either use Blueprint components (which handle dark theme internally) or explicitly set dark colors on custom elements via `--bp-palette-*` CSS variables.
- Surface color hierarchy in dark theme: `--bp-palette-dark-gray-1` (app background), `--bp-palette-dark-gray-2` (raised surfaces like headers), `--bp-palette-dark-gray-5` (borders/dividers), `--bp-palette-black` (terminal/code backgrounds only).

Use Blueprint primitives, don't reinvent
- Do NOT write custom styled `<button>`, `<input>`, `<select>`, `<dialog>`, or `<div>` elements when Blueprint has a component for it. Use `Button`, `AnchorButton`, `InputGroup`, `HTMLSelect`, `Dialog`, `Card`, `Alert`, `Callout`, `Tag`, `Menu`, `MenuItem`, `Navbar`, `NonIdealState`, `Section`, `SectionCard`, `Collapse`, `Icon`, `TextArea`, `FormGroup`, `Checkbox`, `Switch`, `Tabs`, `Tree`, `Spinner`, `ProgressBar`, `Tooltip`, `Popover`, etc.
- Do NOT write custom CSS for things Blueprint handles (elevation shadows, focus rings, intent colors, disabled states, hover states). Use the component props: `intent`, `variant`, `size`, `elevation`, `compact`, `fill`, `disabled`, `interactive`, `minimal`.
- For icons, use Blueprint's `Icon` component or pass icon name strings to component `icon` props (e.g., `icon="cog"`, `icon="plus"`). Do NOT install or use lucide-react, heroicons, or other icon libraries.
- For semantic coloring, use Blueprint's intent system (`intent="primary"`, `"success"`, `"warning"`, `"danger"`). Do NOT hardcode hex color values for standard UI states.
- For button styles, use Blueprint's variant system (`variant="solid"`, `"outlined"`, `"minimal"`).
- For external links styled as buttons, use `AnchorButton` instead of wrapping `<a>` around `<Button>`.
- For empty/error/loading states, use `NonIdealState`. For inline alerts/banners, use `Callout`. For confirmation prompts, use `Alert`. For modals, use `Dialog` with `DialogBody`/`DialogFooter`. For selections from a list, use `Select`/`Omnibar` from `@blueprintjs/select`.

## Cursor Cloud specific instructions

### Services overview

This is a two-package npm project (root runtime + `web-ui/` sub-package). No databases or Docker required.

| Service | Port | Start command |
|---------|------|--------------|
| Runtime server (tRPC + PTY) | 3484 | `npm run dev` |
| Web UI (Vite HMR) | 4173 | `npm run web:dev` |

Both must run concurrently for full dev experience. Use `http://127.0.0.1:4173` for UI work (proxies API to :3484).

### Commands reference

All standard dev commands are in `DEVELOPMENT.md`. Key ones:
- `npm run check` — lint + typecheck + test (same as pre-commit hook)
- `npm run test` / `npm run web:test` — runtime / web-ui vitest suites
- `npm run typecheck` / `npm run web:typecheck` — runtime / web-ui type checking
- `npm run lint` — biome lint (both packages)
- `npm run build` — full production build

### Non-obvious caveats

- `node-pty` is a native C++ addon. The system needs `python3`, `make`, and `g++` for `npm install` to succeed. These are pre-installed in the cloud VM.
- The runtime server (`npm run dev`) creates a `.kanban/` directory in the workspace for file-based state. This is gitignored.
- The Vite dev server proxies `/api/*` to the runtime server at `:3484`. If the runtime isn't running, the web UI will load but show connection errors.
- Lint warnings exist in the codebase (unused imports/params); these are non-blocking — `biome lint` exits 0 with warnings.
- No PostHog telemetry key is needed for development; telemetry silently skips when `POSTHOG_KEY` is absent.

### Running Kanban with agent CLIs (Claude Code / Codex)

- To test Kanban end-to-end with real agents, build first (`npm run build`), then run `node dist/cli.js --port 3484` from a target git repo.
- **Do NOT pass `ANTHROPIC_API_KEY` in the environment** when launching Kanban if the user has logged in to Claude Code interactively (`claude` login). The env var triggers an interactive API-key confirmation prompt inside the PTY that blocks the task.
- Claude Code's first-time onboarding (theme picker, bypass-permissions acceptance) runs inside Kanban's embedded terminal. These prompts block the agent until answered. Pre-complete onboarding by running `claude -p "hello" --dangerously-skip-permissions` once from the CLI before using Kanban.
- Codex CLI requires `codex login` (device auth or API key). The stored credential lives in `~/.codex/` and persists across sessions.
