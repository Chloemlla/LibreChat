import dedent from 'dedent';

const WIDGET_TAG = 'GenerateWidget';

/**
 * Protocol directive injected into every agent turn when the feature is on.
 *
 * The rules here are load-bearing in a way prose usually is not: the client
 * pairs `<GenerateWidget ...>` with its JSON body by the blank-line rule of
 * raw HTML blocks, and a spec that drifts from the `widgetSpec` shape renders
 * as literal text. Both constraints are therefore stated explicitly rather
 * than left to the model's formatting habits.
 */
const widgetsPrompt = dedent`You can answer with an interactive card instead of prose.

# When a card is worth it
- The answer is something the user would want to *manipulate*: drag a parameter, step through states, toggle a view, compare options, enter values and see the result.
- A static explanation would be long, or would need several examples to make the same point.
- Reach for one only when it earns its place. A greeting, a definition, a short factual answer, or a request for an opinion gets prose. When you are unsure, answer in prose.

# How to emit one
Write a short sentence of ordinary prose first, then the tag, alone in the message:

<${WIDGET_TAG} height="600px">
{"widgetSpec": {"height": "600px", "prompt": "**Objective:** …\\n**Data State:** …\\n**Inputs:** …\\n**Behavior:** …"}}
</${WIDGET_TAG}>

Rules the format depends on:
- One JSON object, one \`widgetSpec\` key, one \`prompt\` string. Nothing else.
- **No blank line anywhere inside the block.** Markdown ends a raw HTML block at a blank line; one there splits the tag from its JSON and the card will not render.
- No code fence around the JSON.
- \`height\` is a hint in pixels, e.g. \`"600px"\`. Omit it and the card uses its default.

# What goes in \`prompt\`
The \`prompt\` is a specification for a separate component that will build the card — not the card itself. It cannot see this conversation, so it must be self-contained:

- **Objective:** the single thing the card is for, in one sentence.
- **Data State:** every piece of data the card needs, written out in full. Nothing here may say "as discussed above" or "the values from earlier"; the reader has no earlier.
- **Inputs:** every control the user gets, with names, types, ranges and defaults, and what each one changes.
- **Behavior:** what the card does as the user interacts — what is displayed, what recalculates, what stays fixed.

Write the specification in English prose and lists. Do not write code, JSX, imports or file names in it. Do not state visual styling beyond what the behavior requires.

# After emitting
The card appears where the tag was. Do not repeat the card's contents in prose afterwards, and do not describe what the user will see.`;

/** The codegen instruction handed to the model that compiles a spec into a component. */
const codegenPrompt = dedent`You write a single React component that renders an interactive card.

# Output
- Define one function component named \`Widget\`. The frame renders that name; nothing else is exported or called.
- Output only JavaScript. No Markdown fences, no commentary before or after.
- No \`import\` and no \`require\`. \`React\` and the hooks (\`useState\`, \`useMemo\`, \`useEffect\`, \`useRef\`, \`useCallback\`) are already in scope as bare identifiers. Use them directly.
- No network access of any kind: no \`fetch\`, no \`XMLHttpRequest\`, no WebSocket. All data the card needs is in the specification.

# What the component may use
- Plain JSX with \`className\` only. Tailwind utility classes are available; they are the styling mechanism. Do not emit \`<style>\` tags, CSS files, or inline \`style\` objects except for computed values a class cannot express (a position, a width from state).
- Standard browser and language built-ins.

# Behavior
- Implement exactly the Objective, Data State, Inputs and Behavior in the specification. Nothing more.
- Every input in the specification must be rendered and must visibly change the output.
- All data given in the specification must appear in the initial render — no empty initial state, no "click to load".
- Sized to fit a card: no page-level layout, no fixed full-viewport heights, no scrollbars on the body.
- Readable in both themes: the frame toggles a \`dark\` class on its root to match the application, so give light/dark pairs as \`dark:\` variants on the same element. Never assume one theme.

# Failure
If the specification is incoherent or impossible, output a \`Widget\` that renders a single short sentence saying so. Never output anything but the component.`;

export function generateWidgetsPrompt(enabled: boolean): string | null {
  return enabled ? widgetsPrompt : null;
}

export function generateWidgetCodegenPrompt(spec: string): string {
  return `${codegenPrompt}\n\n# Specification\n\n${spec}`;
}

export const WIDGET_TAG_NAME = WIDGET_TAG;
