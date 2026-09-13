import { visit } from 'unist-util-visit';
import type { Node } from 'unist';
import { clampWidgetHeight, WIDGET_HEIGHT_DEFAULT } from './frame';

export const WIDGET_TAG_NAME = 'GenerateWidget';
export const WIDGET_NODE_TYPE = 'generate-widget';
export const GGB_TAG_NAME = 'GenerateGGB';
export const GGB_NODE_TYPE = 'generate-ggb';

/**
 * The tag as the model writes it. The body is non-greedy so a message carrying two
 * cards pairs each opening tag with its own closing tag, and the closing tag is
 * required: while the tag streams the match fails and the source stays literal text.
 * Markdown ends a raw-HTML block at a blank line, so a body containing one is never
 * reached by this pattern — the spec directive forbids it.
 */
export const WIDGET_TAG_PATTERN = /<GenerateWidget\b([^>]*)>([\s\S]*?)<\/GenerateWidget>/gi;

/**
 * The same shape for the GeoGebra card, whose body is one bare command per line. Its
 * directives carry the same blank-line rule for the same reason.
 */
export const GGB_TAG_PATTERN = /<GenerateGGB\b([^>]*)>([\s\S]*?)<\/GenerateGGB>/gi;

/** A ```json fence around the body, as the model sometimes adds one. */
const JSON_FENCE_PATTERN = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/;
const HEIGHT_ATTRIBUTE_PATTERN = /height\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const PIXEL_HEIGHT_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i;

/**
 * A ggb body is unbounded model output arriving a token at a time, so both the number of
 * commands and the length of one are capped before anything reaches a frame. Whatever
 * the caps drop is counted, not swallowed: the card says the drawing is incomplete
 * rather than showing a construction the model never wrote.
 */
export const GGB_COMMAND_MAX_COUNT = 200;
export const GGB_COMMAND_MAX_LENGTH = 500;

export interface WidgetSpec {
  prompt: string;
  height: string | null;
}

export interface ParsedWidgetTag {
  /** The `widgetSpec.prompt` text posted to the compile endpoint. */
  spec: string;
  /** Sanitized pixel height, advisory; the frame reports its own. */
  height: number;
  /** The exact source, echoed verbatim when the feature is disabled. */
  raw: string;
}

export interface WidgetNodeProperties {
  spec: string;
  height: string;
  raw: string;
}

export interface ParsedGgbTag {
  commands: string[];
  /** Commands the caps dropped, so the card can report a short construction. */
  dropped: number;
  /** Sanitized pixel height, advisory; the frame reports its own. */
  height: number;
  /** The exact source, echoed verbatim when the feature is disabled. */
  raw: string;
}

export interface GgbNodeProperties {
  /** The commands, one per line, exactly as the tag body wrote them. */
  commands: string;
  dropped: string;
  height: string;
  raw: string;
}

export type CardNodeProperties = WidgetNodeProperties | GgbNodeProperties;

/** The hast element react-markdown hands the component, carrying `data.hProperties`. */
export interface CardNodeProps<Properties> {
  node: {
    properties: Partial<Properties>;
  };
}

export type WidgetNodeProps = CardNodeProps<WidgetNodeProperties>;
export type GgbNodeProps = CardNodeProps<GgbNodeProperties>;

interface CardMarkdownNode {
  type: string;
  value?: string;
  data?: {
    hName: string;
    hProperties: CardNodeProperties;
  };
  children?: CardMarkdownNode[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parsePixelHeight = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const match = PIXEL_HEIGHT_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const readHeightAttribute = (attributes: string): string | null => {
  const match = HEIGHT_ATTRIBUTE_PATTERN.exec(attributes);
  return match ? (match[1] ?? match[2] ?? null) : null;
};

/**
 * One JSON object, one `widgetSpec` key, one `prompt` string. Anything else — a
 * truncated stream, prose the model wrapped around the JSON, a missing prompt — is
 * `null`, and the caller leaves the source in the message untouched.
 */
export function parseWidgetSpec(body: string): WidgetSpec | null {
  const trimmed = body.trim();
  const fenced = JSON_FENCE_PATTERN.exec(trimmed);
  const json = (fenced ? fenced[1] : trimmed).trim();
  if (!json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }
  const spec = parsed.widgetSpec;
  if (!isRecord(spec)) {
    return null;
  }
  const prompt = spec.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return null;
  }
  const height = spec.height;
  return { prompt, height: typeof height === 'string' ? height : null };
}

export function parseWidgetTag(match: RegExpExecArray): ParsedWidgetTag | null {
  const spec = parseWidgetSpec(match[2]);
  if (!spec) {
    return null;
  }

  const height =
    parsePixelHeight(readHeightAttribute(match[1])) ??
    parsePixelHeight(spec.height) ??
    WIDGET_HEIGHT_DEFAULT;

  return {
    spec: spec.prompt,
    height: clampWidgetHeight(height),
    raw: match[0],
  };
}

const splitCommands = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * One command per non-blank line, in the order the model wrote them. A body with no
 * command at all is `null`, so an empty tag stays visible text rather than becoming an
 * empty card.
 */
export function parseGgbTag(match: RegExpExecArray): ParsedGgbTag | null {
  const commands = splitCommands(match[2]);
  const kept = commands
    .filter((command) => command.length <= GGB_COMMAND_MAX_LENGTH)
    .slice(0, GGB_COMMAND_MAX_COUNT);

  if (kept.length === 0) {
    return null;
  }

  const height = parsePixelHeight(readHeightAttribute(match[1])) ?? WIDGET_HEIGHT_DEFAULT;

  return {
    commands: kept,
    dropped: commands.length - kept.length,
    height: clampWidgetHeight(height),
    raw: match[0],
  };
}

/**
 * One card protocol: the tag the model writes, and how a matched tag becomes a node.
 * Everything else — finding the tags inside a node's source, tiling the text between
 * them, leaving an unpaired tag literal — is the same for both protocols.
 */
interface CardTag {
  pattern: RegExp;
  node: (match: RegExpExecArray) => CardMarkdownNode | null;
}

const cardNode = (nodeType: string, properties: CardNodeProperties): CardMarkdownNode => ({
  type: nodeType,
  data: { hName: nodeType, hProperties: properties },
});

const widgetTag: CardTag = {
  pattern: WIDGET_TAG_PATTERN,
  node: (match) => {
    const parsed = parseWidgetTag(match);
    return parsed === null
      ? null
      : cardNode(WIDGET_NODE_TYPE, {
          spec: parsed.spec,
          height: String(parsed.height),
          raw: parsed.raw,
        });
  },
};

const ggbTag: CardTag = {
  pattern: GGB_TAG_PATTERN,
  node: (match) => {
    const parsed = parseGgbTag(match);
    return parsed === null
      ? null
      : cardNode(GGB_NODE_TYPE, {
          commands: parsed.commands.join('\n'),
          dropped: String(parsed.dropped),
          height: String(parsed.height),
          raw: parsed.raw,
        });
  },
};

const CARD_TAGS: CardTag[] = [widgetTag, ggbTag];

interface CardMatch {
  index: number;
  length: number;
  node: CardMarkdownNode;
}

const findCardMatches = (value: string, tag: CardTag): CardMatch[] => {
  /* A fresh pattern per scan: the exported one is global and carries `lastIndex` across
     calls, which would make one message's scan start where the previous one stopped. */
  const pattern = new RegExp(tag.pattern.source, 'gi');
  const matches: CardMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const node = tag.node(match);
    if (node) {
      matches.push({ index: match.index, length: match[0].length, node });
    }
  }

  return matches;
};

/**
 * Split a node's source into text and card segments. Returns `null` when nothing
 * parsed, which leaves the node exactly as markdown produced it — that is what keeps
 * a streaming or malformed tag visible as text.
 */
const scanValue = (value: string): CardMarkdownNode[] | null => {
  const matches = CARD_TAGS.flatMap((tag) => findCardMatches(value, tag)).sort(
    (left, right) => left.index - right.index,
  );
  if (matches.length === 0) {
    return null;
  }

  const segments: CardMarkdownNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    /* A tag the model nested inside the other protocol's body lies inside that card's
       source: the outer tag wins, and the inner one is not emitted a second time. */
    if (match.index < cursor) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ type: 'text', value: value.slice(cursor, match.index) });
    }
    segments.push(match.node);
    cursor = match.index + match.length;
  }

  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }
  return segments;
};

const scanNodes = (tree: Node, nodeType: string): void => {
  visit(tree, nodeType, (node, index, parent) => {
    /* `visit` types the index as `number | null | undefined` depending on its overload,
       so the guard is written against the narrowed type rather than one absent value. */
    const current = node as CardMarkdownNode;
    if (typeof current.value !== 'string' || typeof index !== 'number') {
      return;
    }
    const segments = scanValue(current.value);
    if (!segments) {
      return;
    }
    const parentNode = parent as CardMarkdownNode | undefined;
    parentNode?.children?.splice(index, 1, ...segments);
    return index + segments.length;
  });
};

/**
 * An opening tag that does not start its own block — prose directly above it with no
 * blank line between — is inline HTML, so markdown keeps it inside the paragraph and
 * splits the tag across sibling nodes. Reassembling the paragraph's source recovers the
 * tag; the paragraph is then replaced by the card and the text around it, since a card
 * is a block and cannot live inside a `<p>`.
 *
 * Only text and inline HTML children reproduce their own source: a text node's value is
 * its text, an html node's value is the tag itself. Any other child — emphasis, a link,
 * inline code — has nothing to contribute, so the paragraph is left exactly as markdown
 * made it. A tag that stays literal text is visible and recoverable; prose a rebuild
 * silently deleted is neither.
 */
const scanParagraphs = (tree: Node): void => {
  visit(tree, 'paragraph', (node, index, parent) => {
    const paragraph = node as CardMarkdownNode;
    const children = paragraph.children;
    if (!children || typeof index !== 'number') {
      return;
    }

    let source = '';
    for (const child of children) {
      if ((child.type !== 'text' && child.type !== 'html') || typeof child.value !== 'string') {
        return;
      }
      source += child.value;
    }

    const segments = scanValue(source);
    if (!segments) {
      return;
    }
    const parentNode = parent as CardMarkdownNode | undefined;
    parentNode?.children?.splice(index, 1, ...segments);
    return index + segments.length;
  });
};

/**
 * A complete tag arriving on its own is an mdast `html` node — not a text node — so
 * both node types are scanned, and the paragraph pass runs last so it only sees what
 * the per-node passes could not pair.
 */
export function generateWidgetPlugin() {
  return (tree: Node) => {
    scanNodes(tree, 'text');
    scanNodes(tree, 'html');
    scanParagraphs(tree);
  };
}
