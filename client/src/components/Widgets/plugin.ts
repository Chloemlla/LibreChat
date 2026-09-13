import { visit } from 'unist-util-visit';
import type { Node } from 'unist';
import { clampWidgetHeight, WIDGET_HEIGHT_DEFAULT } from './frame';

export const WIDGET_TAG_NAME = 'GenerateWidget';
export const WIDGET_NODE_TYPE = 'generate-widget';

/**
 * The tag as the model writes it. The body is non-greedy so a message carrying two
 * cards pairs each opening tag with its own closing tag, and the closing tag is
 * required: while the tag streams the match fails and the source stays literal text.
 * Markdown ends a raw-HTML block at a blank line, so a body containing one is never
 * reached by this pattern — the spec directive forbids it.
 */
export const WIDGET_TAG_PATTERN = /<GenerateWidget\b([^>]*)>([\s\S]*?)<\/GenerateWidget>/gi;

/** A ```json fence around the body, as the model sometimes adds one. */
const JSON_FENCE_PATTERN = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/;
const HEIGHT_ATTRIBUTE_PATTERN = /height\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const PIXEL_HEIGHT_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i;

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

/** The hast element react-markdown hands the component, carrying `data.hProperties`. */
export interface WidgetNodeProps {
  node: {
    properties: {
      spec?: string;
      height?: string;
      raw?: string;
    };
  };
}

interface WidgetMarkdownNode {
  type: string;
  value?: string;
  data?: {
    hName: string;
    hProperties: WidgetNodeProperties;
  };
  children?: WidgetMarkdownNode[];
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

/**
 * Split a node's source into text and card segments. Returns `null` when nothing
 * parsed, which leaves the node exactly as markdown produced it — that is what keeps
 * a streaming or malformed tag visible as text.
 */
const scanValue = (value: string): WidgetMarkdownNode[] | null => {
  const pattern = new RegExp(WIDGET_TAG_PATTERN.source, 'gi');
  const segments: WidgetMarkdownNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const parsed = parseWidgetTag(match);
    if (!parsed) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ type: 'text', value: value.slice(cursor, match.index) });
    }
    segments.push({
      type: WIDGET_NODE_TYPE,
      data: {
        hName: WIDGET_NODE_TYPE,
        hProperties: {
          spec: parsed.spec,
          height: String(parsed.height),
          raw: parsed.raw,
        },
      },
    });
    cursor = match.index + match[0].length;
  }

  if (segments.length === 0) {
    return null;
  }
  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }
  return segments;
};

const scanNodes = (tree: Node, nodeType: string): void => {
  visit(tree, nodeType, (node, index, parent) => {
    const current = node as WidgetMarkdownNode;
    if (typeof current.value !== 'string' || index === undefined) {
      return;
    }
    const segments = scanValue(current.value);
    if (!segments) {
      return;
    }
    const parentNode = parent as WidgetMarkdownNode | undefined;
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
    const paragraph = node as WidgetMarkdownNode;
    const children = paragraph.children;
    if (!children || index === undefined) {
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
    const parentNode = parent as WidgetMarkdownNode | undefined;
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
