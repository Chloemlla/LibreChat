import {
  generateGeogebraPrompt,
  generateWidgetsPrompt,
  generateWidgetCodegenPrompt,
} from './index';

describe('generateWidgetsPrompt', () => {
  it('returns null when the feature is disabled, so nothing is injected', () => {
    expect(generateWidgetsPrompt(false)).toBeNull();
  });

  it('returns the directive when the feature is enabled', () => {
    const prompt = generateWidgetsPrompt(true);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('<GenerateWidget height="600px">');
    expect(prompt).toContain('</GenerateWidget>');
  });

  /**
   * The client pairs the tag with its JSON body by scanning text, and markdown
   * ends a raw HTML block at a blank line. A blank line inside the example the
   * model is shown would teach it to emit exactly the shape that fails to
   * render, so the example block is asserted to be contiguous.
   */
  it('shows an example block with no blank line between the tag and its JSON', () => {
    const prompt = generateWidgetsPrompt(true) ?? '';
    const lines = prompt.split('\n');
    const openIndex = lines.findIndex((line) => line.startsWith('<GenerateWidget'));
    expect(openIndex).toBeGreaterThanOrEqual(0);

    const bodyIndex = openIndex + 1;
    expect(lines[bodyIndex].trim()).not.toBe('');
    expect(lines[bodyIndex]).toContain('widgetSpec');

    const closeIndex = bodyIndex + 1;
    expect(lines[closeIndex].trim()).toBe('</GenerateWidget>');
  });

  /**
   * The JSON body carries an escaped newline inside the `prompt` string. The
   * directive must reach the model with the backslash intact — a real newline
   * there would be the blank-line case above.
   */
  it('keeps the escaped newline inside the example spec', () => {
    const prompt = generateWidgetsPrompt(true) ?? '';
    expect(prompt).toContain('\\n**Data State:**');
  });

  it('names every section the codegen prompt is told to implement', () => {
    const prompt = generateWidgetsPrompt(true) ?? '';
    for (const section of ['Objective:', 'Data State:', 'Inputs:', 'Behavior:']) {
      expect(prompt).toContain(section);
    }
  });
});

describe('generateGeogebraPrompt', () => {
  it('returns null when no origin is configured, so nothing is injected', () => {
    expect(generateGeogebraPrompt(undefined)).toBeNull();
  });

  /** An empty string is the same absence the schema leaves behind when the key is
   *  unset, and must not be read as a configured origin. */
  it('returns null for an empty origin', () => {
    expect(generateGeogebraPrompt('')).toBeNull();
  });

  it('returns the directive when an origin is configured', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com');
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('<GenerateGGB height="480px">');
    expect(prompt).toContain('</GenerateGGB>');
  });

  /**
   * The configured origin decides where the client loads the frame from, and the
   * model has no use for the address. Keeping it out of the prompt also keeps an
   * operator-supplied string out of the instruction text.
   */
  it('does not interpolate the origin into the directive', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com') ?? '';
    expect(prompt).not.toContain('ggb.example.com');
  });

  /**
   * Same load-bearing rule as the widget example: the client pairs the tag with
   * its body by scanning text, and markdown ends a raw HTML block at a blank
   * line. The example the model is shown must therefore be contiguous, and each
   * line of it must be one command rather than prose.
   */
  it('shows an example block whose body is unbroken command lines', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com') ?? '';
    const lines = prompt.split('\n');
    const openIndex = lines.findIndex((line) => line.startsWith('<GenerateGGB'));
    expect(openIndex).toBeGreaterThanOrEqual(0);

    const closeIndex = lines.indexOf('</GenerateGGB>');
    expect(closeIndex).toBeGreaterThan(openIndex);
    expect(closeIndex - openIndex).toBeGreaterThan(1);

    const body = lines.slice(openIndex + 1, closeIndex);
    for (const line of body) {
      expect(line.trim()).not.toBe('');
    }
    expect(body.join('\n')).toContain('f(x)=x^2');
    expect(body.join('\n')).toContain('Circle(A,3)');
  });

  it('states the blank-line and one-command-per-line rules explicitly', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com') ?? '';
    expect(prompt).toMatch(/No blank line/);
    expect(prompt).toMatch(/One GeoGebra command per line/);
  });

  /** The two card kinds coexist, so the directive has to say which one an answer
   *  wants instead of leaving the model to guess. */
  it('gives a rule for choosing between a figure and a React card', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com') ?? '';
    expect(prompt).toMatch(/interactive card/i);
    expect(prompt).toMatch(/one card per answer/i);
  });

  it('bounds the figure so a runaway command list is not the shape it teaches', () => {
    const prompt = generateGeogebraPrompt('https://ggb.example.com') ?? '';
    expect(prompt).toContain('about 40 commands');
  });
});

describe('generateWidgetCodegenPrompt', () => {
  it('appends the specification verbatim', () => {
    const spec = '**Objective:** plot a sine wave.';
    const prompt = generateWidgetCodegenPrompt(spec);
    expect(prompt).toContain(spec);
  });

  it('states the sandbox contract the compiled component must honour', () => {
    const prompt = generateWidgetCodegenPrompt('spec');
    expect(prompt).toContain('Widget');
    expect(prompt).toMatch(/No `import` and no `require`/);
    expect(prompt).toMatch(/No network access/);
  });
});
