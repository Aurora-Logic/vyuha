/** 210mm at CSS pixels. */
export const A4_WIDTH_PX = 794;

/**
 * Zoom steps the fit chooses from — classes, not a computed transform, so
 * nothing is styled inline. A transform rather than CSS `zoom`: engines
 * disagree on whether a zoomed box's layout size is the scaled one, and on
 * the owner's phone the sheet sat against the left edge under both a
 * centred zoomed box and a zoomed centring container. A transform never
 * changes layout, so the sheet is centred with left-1/2 and a -50%
 * translate in every engine; what the transform leaves behind is layout
 * height, which the stage gives back by sizing the sheet's box to the
 * measured sheet times the step (owner, 22 Aug 2026: a margin sized to A4
 * pulled the caption up behind the shorter packing slip). Steps are close
 * together at the small end, where a phone lives.
 */
export const ZOOMS = [
  { value: 0.4, className: 'scale-[0.4] mb-[calc(297mm*-0.6)]' },
  { value: 0.42, className: 'scale-[0.42] mb-[calc(297mm*-0.58)]' },
  { value: 0.45, className: 'scale-[0.45] mb-[calc(297mm*-0.55)]' },
  { value: 0.48, className: 'scale-[0.48] mb-[calc(297mm*-0.52)]' },
  { value: 0.5, className: 'scale-[0.5] mb-[calc(297mm*-0.5)]' },
  { value: 0.55, className: 'scale-[0.55] mb-[calc(297mm*-0.45)]' },
  { value: 0.6, className: 'scale-[0.6] mb-[calc(297mm*-0.4)]' },
  { value: 0.65, className: 'scale-[0.65] mb-[calc(297mm*-0.35)]' },
  { value: 0.7, className: 'scale-[0.7] mb-[calc(297mm*-0.3)]' },
  { value: 0.75, className: 'scale-[0.75] mb-[calc(297mm*-0.25)]' },
  { value: 0.8, className: 'scale-[0.8] mb-[calc(297mm*-0.2)]' },
  { value: 0.85, className: 'scale-[0.85] mb-[calc(297mm*-0.15)]' },
  { value: 0.9, className: 'scale-[0.9] mb-[calc(297mm*-0.1)]' },
  { value: 1, className: 'scale-100' },
] as const;

export interface FitDims {
  /** The sheet's layout height in px; the transform does not change it. */
  readonly naturalHeight: number;
  /** The sheet's layout width in px — 210mm, known rather than measured. */
  readonly naturalWidth: number;
  readonly availableHeight: number;
  readonly availableWidth: number;
}

/**
 * The largest zoom step whose scaled sheet clears the stage in BOTH
 * dimensions. It fits by whichever side is tighter, measured, not guessed.
 *
 * The predecessor chose the dimension from an isMobile flag — height on a
 * desk, width on a phone — and two things broke a packing slip: the slip is
 * short, so height-fitting a short sheet on a narrow viewport took a
 * near-full scale and spilled the 210mm width off both edges; and the mobile
 * flag is false on the first paint (it settles in a post-paint effect), so
 * every phone briefly height-fit as well. Testing both sides removes the
 * guess and the flash.
 */
export function fitZoomIndex(dims: FitDims): number {
  if (dims.naturalHeight <= 0 || dims.availableHeight <= 0 || dims.availableWidth <= 0) return ZOOMS.length - 1;
  for (let i = ZOOMS.length - 1; i >= 0; i -= 1) {
    const step = ZOOMS[i];
    if (step !== undefined && dims.naturalHeight * step.value <= dims.availableHeight && dims.naturalWidth * step.value <= dims.availableWidth) {
      return i;
    }
  }
  return 0;
}
