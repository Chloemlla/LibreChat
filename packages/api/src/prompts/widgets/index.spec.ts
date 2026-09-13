import { generateWidgetsPrompt, generateWidgetCodegenPrompt } from './index';

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
