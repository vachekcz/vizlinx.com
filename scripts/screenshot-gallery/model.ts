export type GalleryCaption = {
  title: string;
  description: string;
};

export type GalleryState = {
  slug: string;
  title: string;
  /** Longer human description of the state; absent when no caption was provided. */
  description?: string;
  /** viewport name -> relative image path */
  images: Record<string, string>;
};

export type GallerySection = {
  slug: string;
  title: string;
  states: GalleryState[];
};

export type GalleryModel = {
  viewports: string[];
  sections: GallerySection[];
};

// Segments are restricted to a URL/CSS/HTML-safe slug charset so the
// generator can interpolate them into markup without escaping concerns.
const SCREENSHOT_PATH = /^([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\.png$/;

export function titleFromSlug(slug: string): string {
  const bare = slug.replace(/^\d+-/, '').replaceAll('-', ' ');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function byNumericPrefix(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Builds the gallery model from screenshot paths and optional captions.
 * Caption keys are viewport-less state slugs, e.g. "01-onboarding/01-biometrics".
 */
export function buildGalleryModel(
  relativePaths: string[],
  captions: Record<string, GalleryCaption> = {},
): GalleryModel {
  const viewports = new Set<string>();
  const sections = new Map<string, Map<string, Record<string, string>>>();

  for (const relativePath of relativePaths) {
    const match = SCREENSHOT_PATH.exec(relativePath);
    if (!match) continue;
    const [, viewport, sectionSlug, stateSlug] = match;
    viewports.add(viewport);
    const states =
      sections.get(sectionSlug) ?? new Map<string, Record<string, string>>();
    const images = states.get(stateSlug) ?? {};
    images[viewport] = relativePath;
    states.set(stateSlug, images);
    sections.set(sectionSlug, states);
  }

  return {
    viewports: [...viewports].sort(byNumericPrefix),
    sections: [...sections.entries()]
      .sort(([a], [b]) => byNumericPrefix(a, b))
      .map(([sectionSlug, states]) => ({
        slug: sectionSlug,
        title: titleFromSlug(sectionSlug),
        states: [...states.entries()]
          .sort(([a], [b]) => byNumericPrefix(a, b))
          .map(([stateSlug, images]) => {
            const caption = captions[`${sectionSlug}/${stateSlug}`];
            return {
              slug: stateSlug,
              title: caption?.title ?? titleFromSlug(stateSlug),
              description: caption?.description,
              images,
            };
          }),
      })),
  };
}
