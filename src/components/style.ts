import type { CSSProperties } from 'react';
import { colorVar, isCustomColor } from '../lib/model';

// Paints the tracker colors
export const colorStyle = (color: string, extra: CSSProperties = {}) =>
  ({ '--c': colorVar(color), ...(isCustomColor(color) && { '--on': textOn(color) }), ...extra }) as CSSProperties;

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
  const DARK = 0.0137; // luminance of #15202B, the light theme's text color
  return (luminance + 0.05) / (DARK + 0.05) > 1.05 / (luminance + 0.05) ? '#15202B' : '#FFFFFF';
}
