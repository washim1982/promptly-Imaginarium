// PowerPoint slides, previewed.
//
// The main process reads each slide's shape tree for its text and geometry;
// this lays those out on a slide-shaped canvas at the deck's real aspect
// ratio. It is a preview and says so: themes, images, tables, charts and
// master layouts are not applied, so a slide shows what it says and roughly
// where, not how it is painted.

import { useEffect, useState } from 'react';
import { Loader2, Presentation } from 'lucide-react';
import { officeApi, type SlideDeck } from '../../lib/office/api';
import { cleanError } from '../../lib/desktop';

export default function SlideViewer({ file, legacy }: { file: string; legacy: boolean }) {
  const [deck, setDeck] = useState<SlideDeck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (legacy) {
      setLoading(false);
      setError('This is a pre-2007 .ppt file. Open it in PowerPoint and save as .pptx to preview it here.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    officeApi
      .readSlides(file)
      .then((d) => !cancelled && setDeck(d))
      .catch((err) => !cancelled && setError(cleanError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [file, legacy]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-white/50">
        <Loader2 className="animate-spin" size={18} /> Reading the deck…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-10">
        <p className="max-w-lg text-center text-sm text-red-300">{error}</p>
      </div>
    );
  }
  if (!deck) return null;

  const ratio = deck.height / deck.width;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <p className="mono mb-4 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-300/70">
        <Presentation size={13} /> Preview — text and layout only. Images, themes and charts are not rendered.
      </p>
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        {deck.slides.map((slide) => (
          <figure key={slide.index}>
            <div className="ms-slide" style={{ paddingBottom: `${ratio * 100}%` }}>
              <div className="ms-slide-inner">
                {slide.shapes.map((shape, i) => (
                  <div
                    key={i}
                    className="ms-shape"
                    style={{
                      left: `${shape.x}%`,
                      top: `${shape.y}%`,
                      width: `${shape.w}%`,
                      height: `${shape.h}%`,
                      fontWeight: shape.bold || shape.title ? 700 : 400,
                      fontSize: `${Math.max(0.7, shape.size / 28)}rem`,
                    }}
                  >
                    {shape.text}
                  </div>
                ))}
                {!slide.shapes.length && <p className="ms-slide-empty">No text on this slide</p>}
              </div>
            </div>
            <figcaption className="mono mt-1.5 text-center text-[10px] text-white/30">Slide {slide.index}</figcaption>
          </figure>
        ))}
        {!deck.slides.length && <p className="text-center text-sm text-white/40">This deck has no slides.</p>}
      </div>
    </div>
  );
}
