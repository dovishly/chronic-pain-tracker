import type { CSSProperties } from 'react';
import { colorVar } from '../lib/model';

// Paints the tracker colors
export const colorStyle = (color: string, extra: CSSProperties = {}) =>
  ({ '--c': colorVar(color), ...extra }) as CSSProperties;
