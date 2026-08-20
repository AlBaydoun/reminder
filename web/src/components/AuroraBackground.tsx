import { useUi } from '../store/ui';

/**
 * The ambient backdrop for every non-3D screen: slow drifting colour fields
 * plus a fine grain overlay. Pure CSS, so it costs nothing on a phone and
 * still gives the interface depth. Reduced-motion users get the gradient
 * without the drift, which is handled globally in the stylesheet.
 */
export function AuroraBackground() {
  const effects = useUi((s) => s.effects);
  return (
    <div className="aurora" aria-hidden>
      <span className="aurora__blob aurora__blob--1" />
      <span className="aurora__blob aurora__blob--2" />
      <span className="aurora__blob aurora__blob--3" />
      {effects.heavyBlur && <span className="aurora__grain" />}
    </div>
  );
}
