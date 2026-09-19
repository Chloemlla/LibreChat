import { escapeHtmlAttribute } from '../security/html';

/** The name the server falls back to when a deployment sets no `APP_TITLE`. */
export const DEFAULT_APP_TITLE = 'LibreChat';

/** A `<link>` the shell carries so a browser or an installer can find the deployment's icon. */
export interface SiteIcon {
  rel: string;
  href: string;
  sizes?: string;
  type?: string;
}

/** An entry of the web app manifest's `icons` array. */
export interface WebAppManifestIcon {
  src?: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

/** The parts of a web app manifest this module reads and writes. */
export interface WebAppManifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  icons?: WebAppManifestIcon[];
}

/** A deployment's identity, resolved. Every field is present: the client build no
 *  longer carries one of its own for the server to leave in place. */
export interface SiteBranding {
  appTitle: string;
  icons: readonly SiteIcon[];
  manifestIcons: readonly WebAppManifestIcon[];
}

/** The icon files the client build ships, for a deployment that names no logo. */
const BUILD_ICONS: readonly SiteIcon[] = [
  { rel: 'icon', type: 'image/png', sizes: '32x32', href: 'assets/favicon-32x32.png' },
  { rel: 'icon', type: 'image/png', sizes: '16x16', href: 'assets/favicon-16x16.png' },
  { rel: 'apple-touch-icon', href: 'assets/apple-touch-icon-180x180.png' },
];

/** The same files as the build declared them to the installer, which wants sizes
 *  and `maskable` that a `<link>` has no use for. */
const BUILD_MANIFEST_ICONS: readonly WebAppManifestIcon[] = [
  { src: 'assets/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
  { src: 'assets/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
  { src: 'assets/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
  { src: 'assets/icon-192x192.png', sizes: '192x192', type: 'image/png' },
  { src: 'assets/maskable-icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** What a deployment states about itself in the environment. */
export interface BrandingEnv {
  APP_TITLE?: string;
  APP_LOGO_URL?: string;
}

/**
 * Reads a deployment's identity out of its environment.
 *
 * `APP_LOGO_URL` names one image, so it replaces every icon rather than only the
 * one a browser happens to pick. `sizes` and `purpose` are left as declared:
 * they describe the slot an icon fills, not the file that fills it.
 */
export const resolveSiteBranding = ({ APP_TITLE, APP_LOGO_URL }: BrandingEnv): SiteBranding => {
  const appTitle = APP_TITLE || DEFAULT_APP_TITLE;

  if (!APP_LOGO_URL) {
    return { appTitle, icons: BUILD_ICONS, manifestIcons: BUILD_MANIFEST_ICONS };
  }

  return {
    appTitle,
    icons: BUILD_ICONS.map((icon) => ({ ...icon, href: APP_LOGO_URL })),
    manifestIcons: BUILD_MANIFEST_ICONS.map((icon) => ({ ...icon, src: APP_LOGO_URL })),
  };
};

const TITLE_PATTERN = /<title>[\s\S]*?<\/title>\s*/gi;
const ICON_LINK_PATTERN = /<link\b[^>]*\srel="(?:shortcut icon|icon|apple-touch-icon)"[^>]*>\s*/gi;

/** Serializes one icon as a `<link>`, in the attribute order the build used. */
const renderIcon = ({ rel, href, sizes, type }: SiteIcon): string => {
  const attributes = [`rel="${escapeHtmlAttribute(rel)}"`];

  if (type) {
    attributes.push(`type="${escapeHtmlAttribute(type)}"`);
  }

  if (sizes) {
    attributes.push(`sizes="${escapeHtmlAttribute(sizes)}"`);
  }

  attributes.push(`href="${escapeHtmlAttribute(href)}"`);

  return `<link ${attributes.join(' ')} />`;
};

/**
 * Writes the deployment's name and icons into the HTML shell, which is what lets
 * a rebrand take effect without rebuilding the client: the tab title and the
 * favicon are both readable before any script runs.
 *
 * The shell arrives carrying neither. The client build stopped declaring them so
 * that one value — `APP_TITLE` — could not disagree with the `appTitle` that
 * reaches the client through `/api/config`. Stripping whatever is already there
 * before inserting is what makes the deployment's identity the only one present,
 * even against a `dist/index.html` built before the shell dropped them.
 *
 * Every replacement is a function, so a `$&` in a value stays data rather than
 * expanding into the text it matched.
 */
export const applySiteBranding = (html: string, branding: SiteBranding): string => {
  const { appTitle, icons } = branding;
  const identity = [
    `<title>${escapeHtmlAttribute(appTitle)}</title>`,
    ...icons.map(renderIcon),
  ].join('\n    ');
  const stripped = html.replace(TITLE_PATTERN, '').replace(ICON_LINK_PATTERN, '');

  return stripped.replace(/<\/head>/i, () => `\n    ${identity}\n  </head>`);
};

/**
 * Writes the deployment's name and icons into the web app manifest, so an
 * installed PWA carries them too rather than the ones baked in when the image
 * was built. The build emits the manifest without either, which is what makes
 * this an assignment instead of an override.
 */
export const applyManifestBranding = (source: string, branding: SiteBranding): string => {
  const manifest = JSON.parse(source) as WebAppManifest;

  manifest.name = branding.appTitle;
  manifest.short_name = branding.appTitle;
  manifest.icons = [...branding.manifestIcons];

  return JSON.stringify(manifest);
};
