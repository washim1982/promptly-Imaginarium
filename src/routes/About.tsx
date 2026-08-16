import { Link } from 'react-router-dom';
import { openExternal } from '../lib/desktop';

export default function About() {
  return (
    <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
      <h1 className="text-3xl font-semibold text-white">About Imaginarium</h1>
      <p className="mt-3 text-white/60">
        A private AI workspace that runs Google's Gemma models entirely on your
        own machine.
      </p>

      <section className="mt-8 space-y-4 text-[15px] leading-relaxed text-white/80">
        <p>
          Imaginarium runs large language models locally using{' '}
          <button
            type="button"
            onClick={() =>
              openExternal('https://developers.google.com/edge/litert-lm/js')
            }
            className="text-[var(--color-teal)] underline"
          >
            Google's LiteRT-LM
          </button>{' '}
          runtime and the WebGPU API. There is no inference server: your prompts,
          your documents, and the model itself never leave this computer.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">How it works</h2>
        <p>
          You point the app at a <span className="mono">.litertlm</span> file
          once. From then on it is streamed straight from disk into your GPU —
          the app keeps no copy of it, so a 2 GB model costs 2 GB of disk, not
          four. Each response is generated on-device and streamed into the
          window, and everything works offline.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">Features</h2>
        <ul className="list-disc space-y-1 pl-5 marker:text-white/40">
          <li>
            <strong className="text-white">Chat</strong> — conversational
            assistant powered by Gemma 4 (E2B / E4B), with local history.
          </li>
          <li>
            <strong className="text-white">Research</strong> — a multi-agent deep
            research pipeline (orchestrator, researchers, analyst, critic) with
            mechanical citation verification.
          </li>
          <li>
            <strong className="text-white">PDF Tools</strong> — summarize and ask
            questions about PDFs, text or scanned, with on-device OCR.
          </li>
        </ul>

        <h2 className="pt-2 text-xl font-semibold text-white">Technology</h2>
        <p>
          React, TypeScript, and Vite in an Electron shell. Inference is provided
          by LiteRT-LM on WebGPU. Models are the open-weight Gemma family
          published by the LiteRT community on Hugging Face.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">Contact</h2>
        <p>
          Questions? Open an issue on{' '}
          <button
            type="button"
            onClick={() => openExternal('https://github.com/washim1982/promptly-Imaginarium/issues')}
            className="text-[var(--color-teal)] underline"
          >
            GitHub
          </button>
          . See the{' '}
          <Link to="/privacy" className="text-[var(--color-teal)] underline">
            Privacy Policy
          </Link>{' '}
          for how your data is handled.
        </p>
      </section>
    </div>
  );
}
