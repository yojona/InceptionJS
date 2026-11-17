// The scale the engine paints at. On screens of 2x and more (phones are often
// 2.625 or 3.25) it is the device's ratio rounded to a whole number: a whole
// scale lets a scroll move the last frame's pixels instead of repainting the
// view, and 3 against 3.25 does not show. Below 2x (desktops at 125% or 150%)
// it is the exact ratio, where rounding would blur text. Set with
// Inception.configure({ deviceScale }): 'integer' (default), 'native' for the
// exact ratio always, or a number.
let mode = 'integer';

export function setDeviceScale(value) {
  mode = value === 'native' || (typeof value === 'number' && value > 0) ? value : 'integer';
}

export function deviceScale(ratio = globalThis.devicePixelRatio ?? 1) {
  if (typeof mode === 'number') return mode;
  if (mode === 'native' || ratio < 2) return ratio;
  return Math.round(ratio);
}
