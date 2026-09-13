import { fromMarkdown } from 'mdast-util-from-markdown';
import {
  generateWidgetPlugin,
  GGB_COMMAND_MAX_COUNT,
  GGB_COMMAND_MAX_LENGTH,
  GGB_NODE_TYPE,
  parseGgbTag,
  parseWidgetSpec,
  WIDGET_NODE_TYPE,
} from '../plugin';

type WidgetProperties = { spec?: string; height?: string; raw?: string };

type GgbProperties = { commands?: string; dropped?: string; height?: string; raw?: string };

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

const propertiesOf = <Properties = WidgetProperties>(node: TestNode): Properties => {
  const hProperties = node.data?.hProperties;
  if (typeof hProperties !== 'object' || hProperties === null) {
    throw new Error(`node ${node.type} carries no hProperties`);
  }
  return hProperties as Properties;
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

/** Every string the tree renders, so a tag left as text is found wherever markdown nested it. */
const renderedText = (node: TestNode): string =>
  (node.value ?? '') + (node.children ?? []).map(renderedText).join('');

const GGB_COMMANDS = ['A=(1,2)', 'f(x)=x^2', 'Circle(A,3)'];

const ggbTag = (inner: string, height?: string): string =>
  `<GenerateGGB${heightAttribute(height)}>\n${inner}\n</GenerateGGB>`;

const ggbNodes = (tree: TestNode): TestNode[] =>
  (tree.children ?? []).filter((child) => child.type === GGB_NODE_TYPE);

const commandsOf = (node: TestNode): string[] =>
  (propertiesOf<GgbProperties>(node).commands ?? '').split('\n');

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
      /* A spec with no markdown of its own, so the paragraph holds nothing but text and
         inline HTML. The shape real output takes is the case below. */
      const tree = parse(`Here is a card.\n${tag(body('plot the series'), '600px')}`);

      expect(tree.children?.some((child) => child.type === 'paragraph')).toBe(false);
      expect(widgetNodes(tree)).toHaveLength(1);
    });

    it('leaves a folded tag as text when its spec carries markdown of its own', () => {
      /* The directive's example spec opens with `**Objective:**`, so markdown reads that
         emphasis out of the JSON and into a sibling node. Rebuilding the paragraph would
         mean reprinting the emphasis, and a rebuild that gets prose wrong deletes text the
         user cannot recover, so the pass leaves the source exactly as markdown made it. */
      const tree = parse(`Here is a card.\n${tag(body(), '600px')}`);

      expect(widgetNodes(tree)).toHaveLength(0);
      expect(renderedText(tree)).toContain('<GenerateWidget');
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

describe('a GeoGebra tag', () => {
  it('replaces the tag with the card node and keeps the prose above it', () => {
    const tree = parse(`Here is a figure.\n\n${ggbTag(GGB_COMMANDS.join('\n'), '480px')}`);

    expect(tree.children?.map((child) => child.type)).toEqual(['paragraph', GGB_NODE_TYPE]);
    const [ggb] = ggbNodes(tree);
    expect(propertiesOf<GgbProperties>(ggb)).toMatchObject({
      commands: GGB_COMMANDS.join('\n'),
      dropped: '0',
      height: '480',
    });
  });

  it('carries the exact source so a disabled deployment can echo it', () => {
    const source = ggbTag(GGB_COMMANDS.join('\n'));
    const [ggb] = ggbNodes(parse(source));

    expect(propertiesOf<GgbProperties>(ggb).raw).toBe(source);
  });

  it('pairs two tags in one message', () => {
    const tree = parse(`${ggbTag('A=(1,2)')}\n\n${ggbTag('B=(3,4)', '300px')}`);

    expect(ggbNodes(tree).map((node) => commandsOf(node))).toEqual([['A=(1,2)'], ['B=(3,4)']]);
  });

  it('pairs a widget tag and a GeoGebra tag in the same message', () => {
    const tree = parse(`${tag(body(), '600px')}\n\n${ggbTag('A=(1,2)', '480px')}`);

    expect(tree.children?.map((child) => child.type)).toEqual([WIDGET_NODE_TYPE, GGB_NODE_TYPE]);
    expect(propertiesOf<WidgetProperties>(widgetNodes(tree)[0]).spec).toBe(PROMPT);
    expect(commandsOf(ggbNodes(tree)[0])).toEqual(['A=(1,2)']);
  });

  it('keeps one command per line, trimming each', () => {
    const [ggb] = ggbNodes(parse(ggbTag('  A=(1,2)  \n\tf(x)=x^2  ')));

    expect(commandsOf(ggb)).toEqual(['A=(1,2)', 'f(x)=x^2']);
  });

  it('handles CRLF line endings', () => {
    const tree = parse(`\n\n<GenerateGGB height="480px">\r\nA=(1,2)\r\nB=(3,4)\r\n</GenerateGGB>`);

    expect(commandsOf(ggbNodes(tree)[0])).toEqual(['A=(1,2)', 'B=(3,4)']);
  });

  it('caps the number of commands a tag can carry', () => {
    const commands: string[] = [];
    for (let index = 0; index < GGB_COMMAND_MAX_COUNT + 5; index += 1) {
      commands.push(`A${index}=(1,2)`);
    }
    const [ggb] = ggbNodes(parse(ggbTag(commands.join('\n'))));
    const properties = propertiesOf<GgbProperties>(ggb);

    expect(commandsOf(ggb)).toHaveLength(GGB_COMMAND_MAX_COUNT);
    expect(commandsOf(ggb)[GGB_COMMAND_MAX_COUNT - 1]).toBe(commands[GGB_COMMAND_MAX_COUNT - 1]);
    expect(properties.dropped).toBe('5');
  });

  it('drops a single command longer than the cap and counts it', () => {
    const long = `f(x)=${'x'.repeat(GGB_COMMAND_MAX_LENGTH)}`;
    const [ggb] = ggbNodes(parse(ggbTag([long, 'A=(1,2)'].join('\n'))));
    const properties = propertiesOf<GgbProperties>(ggb);

    expect(commandsOf(ggb)).toEqual(['A=(1,2)']);
    expect(properties.dropped).toBe('1');
  });

  it('leaves a tag with no command at all as text', () => {
    /* The two tags sit on one line, so markdown makes them inline HTML inside a paragraph
       rather than a block of their own; what matters is that the source is still rendered. */
    const tree = parse(`Here is a figure.\n\n<GenerateGGB height="480px"></GenerateGGB>`);

    expect(ggbNodes(tree)).toHaveLength(0);
    expect(renderedText(tree)).toContain('<GenerateGGB');
  });

  it('leaves a tag whose closing tag has not streamed in yet', () => {
    const tree = parse(`Here is a figure.\n\n<GenerateGGB height="480px">\nA=(1,2`);

    expect(ggbNodes(tree)).toHaveLength(0);
    expect(tree.children?.some((child) => child.value?.includes('<GenerateGGB'))).toBe(true);
  });

  it('reassembles a tag markdown folded into the paragraph above it', () => {
    const tree = parse(`Here is a figure.\n${ggbTag('A=(1,2)')}`);

    expect(tree.children?.some((child) => child.type === 'paragraph')).toBe(false);
    expect(ggbNodes(tree)).toHaveLength(1);
  });

  it('keeps a paragraph mixing emphasis with a card, formatting intact', () => {
    const tree = parse(`Here is **a figure**.\n${ggbTag('A=(1,2)')}`);
    const paragraph = (tree.children ?? [])[0];

    expect(paragraph?.type).toBe('paragraph');
    expect(paragraph?.children?.map((child) => child.type)).toContain('strong');
    expect(ggbNodes(tree)).toHaveLength(0);
  });

  it('scans a tag written inline in a text node', () => {
    const segments = runOnText(`before ${ggbTag('A=(1,2)')} after`);

    expect(segments.map((node) => node.type)).toEqual(['text', GGB_NODE_TYPE, 'text']);
    expect(segments[0].value).toBe('before ');
    expect(segments[2].value).toBe(' after');
  });

  it('lets the outer tag win over a card nested in its body', () => {
    const inner = tag(JSON.stringify({ widgetSpec: { prompt: 'x' } }));
    const segments = runOnText(ggbTag(inner));

    expect(segments.map((node) => node.type)).toEqual([GGB_NODE_TYPE]);
  });

  describe('the advisory height', () => {
    it('reads the attribute', () => {
      const [ggb] = ggbNodes(parse(ggbTag('A=(1,2)', '480px')));

      expect(propertiesOf<GgbProperties>(ggb).height).toBe('480');
    });

    it('falls back to the default when the attribute is not a pixel length', () => {
      const [ggb] = ggbNodes(parse(ggbTag('A=(1,2)', 'auto')));

      expect(propertiesOf<GgbProperties>(ggb).height).toBe('320');
    });

    it('clamps a height the frame could not report back', () => {
      const [ggb] = ggbNodes(parse(ggbTag('A=(1,2)', '9000px')));

      expect(propertiesOf<GgbProperties>(ggb).height).toBe('1200');
    });
  });
});

describe('parseGgbTag', () => {
  const matchOf = (source: string): RegExpExecArray => {
    const match = /<GenerateGGB\b([^>]*)>([\s\S]*?)<\/GenerateGGB>/i.exec(source);
    if (!match) {
      throw new Error('the fixture is not a ggb tag');
    }
    return match;
  };

  it('reads the commands, the height and the source', () => {
    const source = ggbTag(GGB_COMMANDS.join('\n'), '480px');

    expect(parseGgbTag(matchOf(source))).toEqual({
      commands: GGB_COMMANDS,
      dropped: 0,
      height: 480,
      raw: source,
    });
  });

  it('reports no height as the default', () => {
    expect(parseGgbTag(matchOf(ggbTag('A=(1,2)')))?.height).toBe(320);
  });

  it('ignores blank lines between commands', () => {
    const parsed = parseGgbTag(matchOf(ggbTag('A=(1,2)\n\n   \nf(x)=x^2')));

    expect(parsed?.commands).toEqual(['A=(1,2)', 'f(x)=x^2']);
  });

  it('rejects a body that carries no command', () => {
    expect(parseGgbTag(matchOf(ggbTag('\n\n')))).toBeNull();
  });

  it('rejects a body whose commands all exceed the length cap', () => {
    const long = 'x'.repeat(GGB_COMMAND_MAX_LENGTH + 1);

    expect(parseGgbTag(matchOf(ggbTag(long)))).toBeNull();
  });
});
