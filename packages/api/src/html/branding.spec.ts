import type { WebAppManifest } from './branding';
import { applyManifestBranding, applySiteBranding, resolveSiteBranding } from './branding';

/** The shape the client build emits: no title, no icons, so the server's identity
 *  is the only one the document can carry. */
const SHELL = [
  '<!DOCTYPE html><html lang="en-US"><head>',
  '<meta charset="utf-8" />',
  '<meta name="theme-color" content="#171717" />',
  '<link rel="modulepreload" crossorigin href="assets/chunk.js" />',
  '<link rel="stylesheet" crossorigin href="assets/index.css" />',
  '<script defer type="module" src="assets/index.js"></script>',
  '</head><body><div id="root"></div></body></html>',
].join('');

const MANIFEST = JSON.stringify({
  display: 'standalone',
  background_color: '#000000',
  theme_color: '#009688',
});

const LOGO = 'https://cdn.example.com/logo.png';

const parsed = (source: string) => JSON.parse(source) as WebAppManifest;

describe('resolveSiteBranding', () => {
  it('falls back to the name and the icons the client build used to declare', () => {
    const branding = resolveSiteBranding({});

    expect(branding.appTitle).toBe('LibreChat');
    expect(branding.icons.map((icon) => icon.href)).toEqual([
      'assets/favicon-32x32.png',
      'assets/favicon-16x16.png',
      'assets/apple-touch-icon-180x180.png',
    ]);
  });

  it('takes the title from the environment, and falls back when it is empty', () => {
    expect(resolveSiteBranding({ APP_TITLE: 'Happy Chat' }).appTitle).toBe('Happy Chat');
    expect(resolveSiteBranding({ APP_TITLE: '' }).appTitle).toBe('LibreChat');
  });

  it('points every icon at the configured logo, keeping the slot each one fills', () => {
    const branding = resolveSiteBranding({ APP_LOGO_URL: LOGO });

    expect(branding.icons).toEqual([
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: LOGO },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: LOGO },
      { rel: 'apple-touch-icon', href: LOGO },
    ]);
    expect(branding.manifestIcons.map((icon) => icon.src)).toEqual([LOGO, LOGO, LOGO, LOGO, LOGO]);
    expect(branding.manifestIcons[4]).toEqual({
      src: LOGO,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
  });
});

describe('applySiteBranding', () => {
  it('names and icons a shell that declares neither', () => {
    const html = applySiteBranding(
      SHELL,
      resolveSiteBranding({ APP_TITLE: 'Happy Chat', APP_LOGO_URL: LOGO }),
    );

    expect(html).toContain('<title>Happy Chat</title>');
    expect(html).toContain(`<link rel="icon" type="image/png" sizes="32x32" href="${LOGO}" />`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${LOGO}" />`);
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'));
  });

  it('replaces the identity a shell built before this change still carries', () => {
    const stale = SHELL.replace(
      '<head>',
      '<head><title>Happy Chat</title><link rel="icon" href="assets/favicon-32x32.png" />',
    );
    const html = applySiteBranding(stale, resolveSiteBranding({ APP_TITLE: 'Chloemlla' }));

    expect(html).not.toContain('Happy Chat');
    expect(html).toContain('<title>Chloemlla</title>');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/rel="icon"/g)).toHaveLength(2);
    expect(html.match(/rel="apple-touch-icon"/g)).toHaveLength(1);
  });

  it('touches only the title and the icon links', () => {
    const shell =
      '<html><head>' +
      '<link data-rel="icon" href="assets/keep.png" />' +
      '<link href="assets/keep.css" data-href="assets/keep.png" rel="stylesheet" />' +
      '<link rel="modulepreload" crossorigin href="assets/chunk.js" />' +
      '<link\n      rel="shortcut icon"\n      href="assets/favicon.ico"\n    />' +
      '</head><body></body></html>';

    const html = applySiteBranding(shell, resolveSiteBranding({ APP_LOGO_URL: LOGO }));

    expect(html).toContain('href="assets/keep.png"');
    expect(html).toContain('href="assets/keep.css"');
    expect(html).toContain('href="assets/chunk.js"');
    expect(html).not.toContain('assets/favicon.ico');
    expect(html).toContain(`<link rel="apple-touch-icon" href="${LOGO}" />`);
  });

  it('escapes values so they cannot close the tag they land in', () => {
    const html = applySiteBranding(
      SHELL,
      resolveSiteBranding({
        APP_TITLE: '</title><script>alert(1)</script>',
        APP_LOGO_URL: 'https://cdn.example.com/a.png" onerror="alert(1)',
      }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&quot;');
  });

  it('treats a replacement-pattern in a value as data', () => {
    /** `$&` survives escaping — the `&` only gains `amp;` behind it — so a
     *  replacement string would expand it into the whole matched `<title>`. */
    const html = applySiteBranding(SHELL, resolveSiteBranding({ APP_TITLE: 'A$&B' }));

    expect(html).toContain('<title>A$&amp;B</title>');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });
});

describe('applyManifestBranding', () => {
  it('names and icons the install, keeping the rest of the manifest', () => {
    const manifest = parsed(
      applyManifestBranding(
        MANIFEST,
        resolveSiteBranding({ APP_TITLE: 'Happy Chat', APP_LOGO_URL: LOGO }),
      ),
    );

    expect(manifest.name).toBe('Happy Chat');
    expect(manifest.short_name).toBe('Happy Chat');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#009688');
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([LOGO, LOGO, LOGO, LOGO, LOGO]);
    expect(manifest.icons?.[4]?.purpose).toBe('maskable');
  });

  it('leaves the build icons in place when the deployment names no logo', () => {
    const manifest = parsed(applyManifestBranding(MANIFEST, resolveSiteBranding({})));

    expect(manifest.name).toBe('LibreChat');
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([
      'assets/favicon-32x32.png',
      'assets/favicon-16x16.png',
      'assets/apple-touch-icon-180x180.png',
      'assets/icon-192x192.png',
      'assets/maskable-icon.png',
    ]);
  });
});
