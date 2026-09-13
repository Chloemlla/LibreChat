import {
  WIDGET_CODE_MAX_LENGTH,
  WIDGET_SPEC_MAX_LENGTH,
  definesWidgetComponent,
  findForbiddenConstruct,
  parseWidgetGenerateRequest,
  validateWidgetCode,
  validateWidgetSpec,
  widgetRejectionMessage,
} from './validate';

const COMPONENT = 'function Widget() { return <div className="p-2">ok</div>; }';

/** Padding that survives trimming, so a length test can hit an exact bound. */
const paddedComponent = (size: number): string => `${COMPONENT}/*${'a'.repeat(size)}*/`;

const forbiddenCases: ReadonlyArray<[string, string]> = [
  ['import', `import React from 'react';\n${COMPONENT}`],
  ['require', `const fs = require('fs');\n${COMPONENT}`],
  ['fetch', 'function Widget() { fetch("/latest"); return null; }'],
  ['XMLHttpRequest', 'function Widget() { return new XMLHttpRequest(); }'],
  ['WebSocket', 'function Widget() { return new WebSocket("wss://example.test"); }'],
  ['<script', 'function Widget() { return <script src="x" />; }'],
];

const rejections = [
  'missing_endpoint',
  'missing_model',
  'spec_missing',
  'spec_empty',
  'spec_too_long',
  'code_empty',
  'code_too_long',
  'code_forbidden',
  'code_missing_component',
] as const;

describe('validateWidgetSpec', () => {
  it('refuses a specification that is not a string', () => {
    expect(validateWidgetSpec(undefined)).toEqual({ ok: false, rejection: 'spec_missing' });
    expect(validateWidgetSpec({ prompt: 'x' })).toEqual({ ok: false, rejection: 'spec_missing' });
  });

  it('refuses an empty or whitespace-only specification', () => {
    expect(validateWidgetSpec('')).toEqual({ ok: false, rejection: 'spec_empty' });
    expect(validateWidgetSpec('   \n\t ')).toEqual({ ok: false, rejection: 'spec_empty' });
  });

  it('refuses a specification past the bound and accepts one at it', () => {
    const atBound = 'a'.repeat(WIDGET_SPEC_MAX_LENGTH);
    expect(validateWidgetSpec(atBound)).toEqual({ ok: true, spec: atBound });
    expect(validateWidgetSpec(`${atBound}a`)).toEqual({
      ok: false,
      rejection: 'spec_too_long',
    });
  });

  it('trims the specification it hands on', () => {
    expect(validateWidgetSpec('\n  **Objective:** plot it  \n')).toEqual({
      ok: true,
      spec: '**Objective:** plot it',
    });
  });
});

describe('validateWidgetCode', () => {
  it('accepts a plain component', () => {
    expect(validateWidgetCode(COMPONENT)).toEqual({ ok: true, code: COMPONENT });
  });

  it('unwraps a Markdown fence the model added anyway', () => {
    expect(validateWidgetCode(`\`\`\`jsx\n${COMPONENT}\n\`\`\``)).toEqual({
      ok: true,
      code: COMPONENT,
    });
  });

  it('refuses empty output and non-string output', () => {
    expect(validateWidgetCode('')).toEqual({ ok: false, rejection: 'code_empty' });
    expect(validateWidgetCode('   ')).toEqual({ ok: false, rejection: 'code_empty' });
    expect(validateWidgetCode(undefined)).toEqual({ ok: false, rejection: 'code_empty' });
  });

  it('refuses a component past the bound and accepts one at it', () => {
    const atBound = paddedComponent(WIDGET_CODE_MAX_LENGTH - COMPONENT.length - 4);
    expect(atBound).toHaveLength(WIDGET_CODE_MAX_LENGTH);
    expect(validateWidgetCode(atBound).ok).toBe(true);
    expect(validateWidgetCode(`${atBound}a`)).toEqual({
      ok: false,
      rejection: 'code_too_long',
    });
  });

  it.each(forbiddenCases)('refuses %s', (label, code) => {
    expect(validateWidgetCode(code)).toEqual({
      ok: false,
      rejection: 'code_forbidden',
      detail: label,
    });
  });

  it('leaves words that merely contain a forbidden name alone', () => {
    const code = 'function Widget() { return <p className="important">fetching</p>; }';
    expect(findForbiddenConstruct(code)).toBeUndefined();
    expect(validateWidgetCode(code).ok).toBe(true);
  });

  it('refuses code that does not define a Widget component', () => {
    expect(validateWidgetCode('const NotAWidget = () => null;')).toEqual({
      ok: false,
      rejection: 'code_missing_component',
    });
  });
});

describe('definesWidgetComponent', () => {
  it.each([
    'function Widget() { return null; }',
    'export default function Widget() { return null; }',
    'function Widget({ rows }) { return null; }',
    'const Widget = () => null;',
    'let Widget = function () { return null; };',
    'class Widget extends React.Component { render() { return null; } }',
  ])('accepts %s', (code) => {
    expect(definesWidgetComponent(code)).toBe(true);
  });

  it('rejects a component with a different name', () => {
    expect(definesWidgetComponent('const Chart = () => null;')).toBe(false);
  });
});

describe('parseWidgetGenerateRequest', () => {
  const spec = '**Objective:** plot the series';

  it('requires an endpoint, a model and a specification', () => {
    expect(parseWidgetGenerateRequest({})).toEqual({ ok: false, rejection: 'missing_endpoint' });
    expect(parseWidgetGenerateRequest({ endpoint: 'openAI' })).toEqual({
      ok: false,
      rejection: 'missing_model',
    });
    expect(parseWidgetGenerateRequest({ endpoint: 'openAI', model: 'gpt-4o-mini' })).toEqual({
      ok: false,
      rejection: 'spec_missing',
    });
    expect(
      parseWidgetGenerateRequest({ endpoint: 'openAI', model: 'gpt-4o-mini', spec: '  ' }),
    ).toEqual({ ok: false, rejection: 'spec_empty' });
  });

  it('returns the parsed request for a well-formed body', () => {
    expect(
      parseWidgetGenerateRequest({ endpoint: 'openAI', model: 'gpt-4o-mini', spec: ` ${spec} ` }),
    ).toEqual({
      ok: true,
      value: { endpoint: 'openAI', model: 'gpt-4o-mini', spec },
    });
  });
});

describe('widgetRejectionMessage', () => {
  it('has a message for every rejection', () => {
    const messages = rejections.map((rejection) => widgetRejectionMessage(rejection));
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(rejections.length);
  });

  it('never echoes model output into a user-facing message', () => {
    expect(widgetRejectionMessage('code_forbidden')).not.toMatch(/import|fetch|script/i);
  });
});
