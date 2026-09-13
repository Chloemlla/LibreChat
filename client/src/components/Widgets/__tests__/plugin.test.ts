import { fromMarkdown } from 'mdast-util-from-markdown';
import { generateWidgetPlugin, parseWidgetSpec, WIDGET_NODE_TYPE } from '../plugin';

type WidgetProperties = { spec?: string; height?: string; raw?: string };

type TestNode = {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: TestNode[];
};

const PROMPT = '**Objective:** plot the series';

const body = (prompt = PROMPT, height?: string): string =>
  JSON.stringify({ widgetSpec: height === undefined ? { prompt } : { prompt, height } });

const heightAttribute = (height?: string): string =>
  height === undefined ? '' : ` height="${height}"`;

const tag = (inner: string, height?: string): string =>
  `<GenerateWidget${heightAttribute(height)}>\n${inner}\n</GenerateWidget>`;

const propertiesOf = (node: TestNode): WidgetProperties => {
  const hProperties = node.data?.hProperties;
  if (typeof hProperties !== 'object' || hProperties === null) {
    throw new Error(`node ${node.type} carries no hProperties`);
  }
  return hProperties as WidgetProperties;
};

const widgetNodes = (tree: TestNode): TestNode[] =>
  (tree.children ?? []).filter((child) => child.type === WIDGET_NODE_TYPE);

/** The real parse path: markdown source → mdast → plugin, exactly as the pipeline runs it. */
const parse = (markdown: string): TestNode => {
  const tree: TestNode = { ...fromMarkdown(markdown) };
  generateWidgetPlugin()(tree);
  return tree;
};

const runOnText = (value: string): TestNode[] => {
  const tree: TestNode = { type: 'root', children: [{ type: 'text', value }] };
  generateWidgetPlugin()(tree);
  return tree.children ?? [];
};

describe('generateWidgetPlugin', () => {
  describe('a complete tag', () => {
    it('replaces the tag with the card node and keeps the prose above it', () => {
      const tree = parse(`Here is a card.\n\n${tag(body(), '600px')}`);

      expect(tree.children?.map((child) => child.type)).toEqual(['paragraph', WIDGET_NODE_TYPE]);
      const [widget] = widgetNodes(tree);
      expect(propertiesOf(widget)).toMatchObject({ spec: PROMPT, height: '600' });
    });

    it('carries the exact source so a disabled deployment can echo it', () => {
      const source = tag(body(), '600px');
      const [widget] = widgetNodes(parse(source));

      expect(propertiesOf(widget).raw).toBe(source);
    });

    it('handles two tags in one message', () => {
      const tree = parse(`${tag(body('first'), '300px')}\n\n${tag(body('second'))}`);

      const specs = widgetNodes(tree).map((node) => propertiesOf(node).spec);

      expect(specs).toEqual(['first', 'second']);
    });

    it('accepts a json fence around the body', () => {
      const [widget] = widgetNodes(parse(tag(`\`\`\`json\n${body()}\n\`\`\``, '600px')));

      expect(propertiesOf(widget).spec).toBe(PROMPT);
    });

    it('reassembles a tag markdown folded into the paragraph above it', () => {
      const tree = parse(`Here is a card.\n${tag(body(), '600px')}`);

      expect(tree.children?.some((child) => child.type === 'paragraph')).toBe(false);
      expect(widgetNodes(tree)).toHaveLength(1);
    });

    it('keeps a paragraph mixing emphasis with a card, formatting intact', () => {
      const tree = parse(`Here is **a card**.\n${tag(body(), '600px')}`);
      const paragraph = (tree.children ?? [])[0];

      expect(paragraph?.type).toBe('paragraph');
      expect(paragraph?.children?.map((child) => child.type)).toContain('strong');
      /* The tag stays visible as text: a rebuilt paragraph would have deleted the
         emphasis, which the user cannot recover from. */
      const source = (paragraph?.children ?? []).map((child) => child.value ?? '').join('');
      expect(source).toContain('<GenerateWidget');
      expect(widgetNodes(tree)).toHaveLength(0);
    });

    it('scans a tag written inline in a text node', () => {
      const segments = runOnText(`before ${tag(body())} after`);

      expect(segments.map((node) => node.type)).toEqual(['text', WIDGET_NODE_TYPE, 'text']);
      expect(segments[0].value).toBe('before ');
      expect(segments[2].value).toBe(' after');
    });
  });

  describe('a tag that must stay text', () => {
    it('leaves a tag whose closing tag has not streamed in yet', () => {
      const tree = parse(`Here is a card.\n\n<GenerateWidget height="600px">\n{"widgetSpec": {`);

      expect(widgetNodes(tree)).toHaveLength(0);
      expect(tree.children?.some((child) => child.value?.includes('<GenerateWidget'))).toBe(true);
    });

    it('leaves a body that is not JSON', () => {
      const tree = parse(`\n\n${tag('{"widgetSpec": {"prompt":', '600px')}`);

      expect(widgetNodes(tree)).toHaveLength(0);
      expect(tree.children?.some((child) => child.value?.includes('widgetSpec'))).toBe(true);
    });

    it('leaves a body with no widgetSpec key', () => {
      const tree = parse(`\n\n${tag('{"prompt": "text"}', '600px')}`);

      expect(widgetNodes(tree)).toHaveLength(0);
    });

    it('leaves a body whose prompt is not a string', () => {
      const tree = parse(`\n\n${tag('{"widgetSpec": {"prompt": 7}}', '600px')}`);

      expect(widgetNodes(tree)).toHaveLength(0);
    });

    it('leaves an empty prompt', () => {
      const tree = parse(`\n\n${tag(body('   '), '600px')}`);

      expect(widgetNodes(tree)).toHaveLength(0);
    });

    it('keeps an unparseable tag in a text node verbatim', () => {
      const value = `before ${tag('not json')} after`;
      const segments = runOnText(value);

      expect(segments).toEqual([{ type: 'text', value }]);
    });
  });

  describe('the advisory height', () => {
    it('prefers the attribute over the spec', () => {
      const [widget] = widgetNodes(parse(tag(body(PROMPT, '300px'), '900px')));

      expect(propertiesOf(widget).height).toBe('900');
    });

    it('falls back to the spec height', () => {
      const [widget] = widgetNodes(parse(tag(body(PROMPT, '480px'))));

      expect(propertiesOf(widget).height).toBe('480');
    });

    it('falls back to the default when neither is a pixel length', () => {
      const [widget] = widgetNodes(parse(tag(body(PROMPT, '50vh'), 'auto')));

      expect(propertiesOf(widget).height).toBe('320');
    });

    it('clamps a height the frame could not report back', () => {
      const [widget] = widgetNodes(parse(tag(body(), '9000px')));

      expect(propertiesOf(widget).height).toBe('1200');
    });
  });

  it('leaves a message with no tag untouched', () => {
    const tree = parse('Just prose.\n\nAnd more.');

    expect(tree.children?.map((child) => child.type)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('parseWidgetSpec', () => {
  it('reads the prompt and height', () => {
    expect(parseWidgetSpec(body(PROMPT, '600px'))).toEqual({ prompt: PROMPT, height: '600px' });
  });

  it('reports a missing height as null', () => {
    expect(parseWidgetSpec(body())).toEqual({ prompt: PROMPT, height: null });
  });

  it('ignores unknown keys', () => {
    const spec = JSON.stringify({ widgetSpec: { prompt: PROMPT }, extra: true });

    expect(parseWidgetSpec(spec)).toEqual({ prompt: PROMPT, height: null });
  });

  it.each(['', 'not json', '[]', 'null', '{"widgetSpec": "text"}'])('rejects %p', (input) => {
    expect(parseWidgetSpec(input)).toBeNull();
  });
});
