// Tracker colors. A tracker's color is a preset key, drawn with the CSS variable --c-<key> from styles.css
// (with light and dark versions), or a custom "#rrggbb" from the editor's color picker, used as-is.
import type { CSSProperties } from 'react';

export const COLORS = ['indigo', 'amber', 'teal', 'rose', 'violet', 'green', 'slate', 'sky'];

export const isCustomColor = (color: string) => /^#[0-9a-f]{6}$/i.test(color);

/**
 * Inline style that paints an element in a tracker's color: styles.css draws with --c, and puts text on
 * it in --on. Unknown keys fall back to slate.
 */
export function colorStyle(color: string): CSSProperties {
  if (isCustomColor(color)) return { '--c': color, '--on': textOn(color) } as CSSProperties;
  return { '--c': `var(--c-${COLORS.includes(color) ? color : 'slate'})` } as CSSProperties;
}

/**
 * Text that reads on a custom color: dark or white, whichever contrasts more. (The preset colors are
 * chosen to suit the theme's own --on.)
 */
function textOn(hex: string): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  const DARK = 0.0206; // luminance of #1E2A24, the light theme's text color
  return (luminance + 0.05) / (DARK + 0.05) > 1.05 / (luminance + 0.05) ? '#1E2A24' : '#FFFFFF';
}
