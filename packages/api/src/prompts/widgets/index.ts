import dedent from 'dedent';

const WIDGET_TAG = 'GenerateWidget';
const GGB_TAG = 'GenerateGGB';

/**
 * Protocol directive injected into every agent turn when the feature is on.
 *
 * The rules here are load-bearing in a way prose usually is not: the client
 * pairs `<GenerateWidget ...>` with its JSON body by the blank-line rule of
 * raw HTML blocks, and a spec that drifts from the `widgetSpec` shape renders
 * as literal text. Both constraints are therefore stated explicitly rather
 * than left to the model's formatting habits.
 *
 * `dedent` reads the raw text, so the `\\n` written inside the example arrives intact —
 * but its final pass replaces a backslash followed by `n` with a real newline, which
 * leaves a stray backslash before the break. The pass after the template puts the escape
 * back: a real newline inside that JSON string would both split the block and make the
 * example invalid JSON.
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
The card appears where the tag was. Do not repeat the card's contents in prose afterwards, and do not describe what the user will see.`.replace(
  /\\\n/g,
  '\\n',
);

/**
 * Protocol directive for the GeoGebra figure card.
 *
 * The `origin` argument is an enable signal, not content: it is deliberately kept
 * out of the text. The model gains nothing from the address, and splicing an
 * operator-supplied string into a prompt is an injection surface with no upside —
 * what the operator configures is where the client loads the frame from, while
 * what the model is told is only that figures are available.
 */
const geogebraPrompt = dedent`You can also answer with a live GeoGebra figure.

# When a figure is worth it
- The answer is a mathematical object the user would want to *see and move*: the graph of a function, a construction of points, lines, circles or polygons, a conic, an intersection, a locus, a transformation, a solid.
- The figure says it better than the algebra alone: a static explanation would be long, or would need several examples to make the same point.
- Reach for one only when it earns its place. A definition, a derivation, a numeric result, or a request for an opinion gets prose. When you are unsure, answer in prose.

# Figure or interactive card
Both are available, and the answer decides which one fits:
- A geometric or algebraic **object** the user should manipulate — use the figure. GeoGebra draws it exactly and lets the user drag it, where a hand-written component only approximates it.
- A **control surface over data or state** — a form, a set of toggles, a multi-step walkthrough, a chart of values you were given — use the interactive card. Those are not a construction, and a figure would express them poorly.
- Emit **one card per answer**, never both for the same point.

# How to emit one
Write a short sentence of ordinary prose first, then the tag, alone in the message:

<${GGB_TAG} height="480px">
A=(1,2)
f(x)=x^2
Circle(A,3)
</${GGB_TAG}>

Rules the format depends on:
- **One GeoGebra command per line**, with nothing else on that line. The body is a command list — not JSON, not prose, not a description of the figure.
- **No blank line anywhere inside the block.** Markdown ends a raw HTML block at a blank line; one there splits the tag from its commands and the figure will not render.
- No code fence around the commands, and no comments or numbering.
- \`height\` is a hint in pixels, e.g. \`"480px"\`. Omit it and the figure uses its default.
- Keep a figure to about 40 commands. The lines run in order, so define a name before you use it and leave out anything the figure does not need.

# The command language
GeoGebra's own commands, written exactly as they are typed into the GeoGebra input bar: \`A=(1,2)\`, \`f(x)=x^2\`, \`Circle(A,3)\`, \`Line(A,B)\`, \`Intersect(f,g)\`, \`Slider(a,-5,5,0.1)\`, \`Polygon(A,B,C)\`. Styling commands such as \`SetColor(f,0,0,1)\` are ordinary commands and work the same way.
- Use only commands you are confident exist under that exact name. A misspelled command raises nothing the user can see — it simply draws nothing, and the figure is wrong.
- Command names are English in every language — write \`Circle\`, not its translation — while the labels you give objects and any text you ask GeoGebra to draw can be in the user's language.
- Every name you reference must be defined by an earlier line, or be a built-in.
- Let GeoGebra choose the view unless the figure needs a particular one; do not spend commands on framing the user can adjust themselves.

# After emitting
The figure appears where the tag was, as a live GeoGebra applet. Do not repeat its contents in prose afterwards, and do not describe what the user will see or how to interact with it.`;

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

/**
 * Null unless the deployment configured `interface.geogebraOrigin`. The figure
 * frame needs `allow-same-origin` and therefore a separate origin of its own, so
 * an unconfigured deployment has no renderer — telling the model otherwise would
 * only make it emit tags that stay literal text.
 */
export function generateGeogebraPrompt(origin: string | undefined): string | null {
  return origin ? geogebraPrompt : null;
}

export function generateWidgetCodegenPrompt(spec: string): string {
  return `${codegenPrompt}\n\n# Specification\n\n${spec}`;
}
