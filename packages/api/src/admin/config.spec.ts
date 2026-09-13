import { isValidFieldPath, getTopLevelSection, getConfigOverrideIssues } from './config';

describe('isValidFieldPath', () => {
  it('accepts simple dot paths', () => {
    expect(isValidFieldPath('interface.modelSelect')).toBe(true);
    expect(isValidFieldPath('registration.socialLogins')).toBe(true);
    expect(isValidFieldPath('a')).toBe(true);
    expect(isValidFieldPath('a.b.c.d')).toBe(true);
  });

  it('rejects empty and non-string', () => {
    expect(isValidFieldPath('')).toBe(false);
    // @ts-expect-error testing invalid input
    expect(isValidFieldPath(undefined)).toBe(false);
    // @ts-expect-error testing invalid input
    expect(isValidFieldPath(null)).toBe(false);
    // @ts-expect-error testing invalid input
    expect(isValidFieldPath(42)).toBe(false);
  });

  it('rejects __proto__ and dunder-prefixed segments', () => {
    expect(isValidFieldPath('__proto__')).toBe(false);
    expect(isValidFieldPath('a.__proto__')).toBe(false);
    expect(isValidFieldPath('__proto__.polluted')).toBe(false);
    expect(isValidFieldPath('a.__proto__.b')).toBe(false);
    expect(isValidFieldPath('__defineGetter__')).toBe(false);
    expect(isValidFieldPath('a.__lookupSetter__')).toBe(false);
    expect(isValidFieldPath('__')).toBe(false);
    expect(isValidFieldPath('a.__.b')).toBe(false);
  });

  it('rejects constructor and prototype segments', () => {
    expect(isValidFieldPath('constructor')).toBe(false);
    expect(isValidFieldPath('a.constructor')).toBe(false);
    expect(isValidFieldPath('constructor.a')).toBe(false);
    expect(isValidFieldPath('prototype')).toBe(false);
    expect(isValidFieldPath('a.prototype')).toBe(false);
    expect(isValidFieldPath('prototype.a')).toBe(false);
  });

  it('allows segments containing but not matching reserved words', () => {
    expect(isValidFieldPath('constructorName')).toBe(true);
    expect(isValidFieldPath('prototypeChain')).toBe(true);
    expect(isValidFieldPath('a.myConstructor')).toBe(true);
  });

  it('rejects MongoDB operator segments', () => {
    expect(isValidFieldPath('webSearch.$[].serperApiKey')).toBe(false);
    expect(isValidFieldPath('speech.tts.$.apiKey')).toBe(false);
    expect(isValidFieldPath('a.$set')).toBe(false);
    expect(isValidFieldPath('$')).toBe(false);
  });
});

describe('getTopLevelSection', () => {
  it('returns first segment of a dot path', () => {
    expect(getTopLevelSection('interface.modelSelect')).toBe('interface');
    expect(getTopLevelSection('registration.socialLogins.github')).toBe('registration');
  });

  it('returns the whole string when no dots', () => {
    expect(getTopLevelSection('interface')).toBe('interface');
  });
});

describe('getConfigOverrideIssues', () => {
  it('accepts a section-keyed fragment of the YAML config', () => {
    expect(getConfigOverrideIssues({})).toEqual([]);
    expect(getConfigOverrideIssues({ interface: { modelSelect: false } })).toEqual([]);
    expect(getConfigOverrideIssues({ registration: { socialLogins: ['github'] } })).toEqual([]);
    expect(
      getConfigOverrideIssues({
        endpoints: {
          custom: [{ name: 'MyEndpoint', apiKey: 'sk-x', baseURL: 'https://x.test/v1' }],
        },
      }),
    ).toEqual([]);
  });

  it('rejects a section the schema does not know, which would never merge', () => {
    const issues = getConfigOverrideIssues({ interfase: { modelSelect: false } });

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('interfase');
  });

  it('rejects a value whose type the section does not accept', () => {
    expect(getConfigOverrideIssues({ interface: { modelSelect: 'yes' } })).toEqual([
      { path: 'interface.modelSelect', message: expect.any(String) },
    ]);
  });

  it('rejects a value outside the range the schema declares', () => {
    const issues = getConfigOverrideIssues({ interface: { temporaryChatRetention: 99_999 } });

    expect(issues.map((issue) => issue.path)).toEqual(['interface.temporaryChatRetention']);
  });

  it('rejects an unknown key inside a section that declares no extras', () => {
    const issues = getConfigOverrideIssues({ endpoints: { bogus: true } });

    expect(issues.map((issue) => issue.path)).toEqual(['endpoints']);
    expect(issues[0].message).toContain('bogus');
  });

  it('leaves a section that needs fields the merge supplies to the merge', () => {
    expect(getConfigOverrideIssues({ skillSync: { github: { enabled: true } } })).toEqual([]);
    expect(getConfigOverrideIssues({ cloudfront: { urlExpiry: 900 } })).toEqual([]);
    expect(getConfigOverrideIssues({ interface: { currency: { rate: 1 } } })).toEqual([]);
  });

  it('accepts any object per MCP server, which the merge folds in field by field', () => {
    expect(
      getConfigOverrideIssues({ mcpServers: { github: { url: 'https://x.test/mcp' } } }),
    ).toEqual([]);
    expect(getConfigOverrideIssues({ mcpServers: { github: { disabled: true } } })).toEqual([]);
    expect(getConfigOverrideIssues({ mcpServers: 'nope' })).toHaveLength(1);
  });

  it('accepts the AppConfig spellings the resolution layer merges, and nothing else', () => {
    expect(getConfigOverrideIssues({ interfaceConfig: { modelSelect: false } })).toEqual([]);
    expect(getConfigOverrideIssues({ turnstileConfig: { siteKey: 'site-key' } })).toEqual([]);
    expect(getConfigOverrideIssues({ mcpConfig: { github: { disabled: true } } })).toEqual([]);
    expect(getConfigOverrideIssues({ paths: { uploads: '/tmp' } })).toHaveLength(1);
    expect(getConfigOverrideIssues({ availableTools: { foo: {} } })).toHaveLength(1);
    expect(getConfigOverrideIssues({ config: { interface: {} } })).toHaveLength(1);
  });
});
