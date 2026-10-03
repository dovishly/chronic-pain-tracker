import type { CSSProperties } from 'react';
import { colorVar } from '../lib/model';

/** Sets --c, the color that tracker-colored elements in styles.css draw with. */
export const colorStyle = (color: string, extra: CSSProperties = {}) =>
  ({ '--c': colorVar(color), ...extra }) as CSSProperties;
