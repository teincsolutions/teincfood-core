/**
 * Responsive helper — plain, no react-native.
 * Host apps with RN can override via adapter; core provides window-based fallback.
 */

export interface ResponsiveState {
  width: number;
  height: number;
  isTablet: boolean;
  isLargeTablet: boolean;
  isLandscape: boolean;
  columns: (minItemWidth: number) => number;
}

function getWindowSize(): { width: number; height: number } {
  if (typeof window !== "undefined") {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  return { width: 1024, height: 768 };
}

export function useResponsive(): ResponsiveState {
  const { width, height } = getWindowSize();
  const isTablet = width >= 768;
  const isLandscape = width > height;
  const isLargeTablet = width >= 1024;

  const columns = (minItemWidth: number) => Math.max(1, Math.floor(width / minItemWidth));

  return { width, height, isTablet, isLargeTablet, isLandscape, columns };
}
