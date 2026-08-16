import { openExternal } from '../lib/desktop';

// Privacy policy for the desktop build. Every claim here is checkable against
// the code — keep it that way when the storage or networking behaviour changes.
export default function Privacy() {
  return (
    <div className="mx-auto w-full max-w-3xl overflow-y-auto px-6 py-10">
      <h1 className="text-3xl font-semibold text-white">Privacy Policy</h1>
      <p className="mono mt-2 text-[11px] text-white/40">
        Last updated: August 15, 2026
      </p>

      <section className="mt-8 space-y-4 text-[15px] leading-relaxed text-white/80">
        <p>
          Imaginarium is designed to be private by default. It runs AI models
          entirely on this computer, so your data stays on your device.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">
          What we collect
        </h2>
        <p>
          <strong className="text-white">Nothing.</strong> We do not operate an
          inference server, account system, analytics, advertising, or tracking
          cookies. We do not collect, store, or transmit your prompts,
          conversations, uploaded files, or model files.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">
          Where your data goes
        </h2>
        <ul className="list-disc space-y-1 pl-5 marker:text-white/40">
          <li>
            <strong className="text-white">Prompts &amp; chats</strong> are
            processed locally on your GPU via WebGPU and are never sent to a
            server.
          </li>
          <li>
            <strong className="text-white">Documents (e.g. PDFs)</strong> are
            parsed on this machine and never uploaded. Scanned PDFs are OCR'd
            locally too — the OCR engine and its language data ship with the app.
          </li>
          <li>
            <strong className="text-white">Model files</strong> stay exactly where
            you put them. The app records the file's path and streams it from
            disk; it never makes its own copy, and it never deletes a file you
            chose.
          </li>
          <li>
            <strong className="text-white">Chat history</strong> is kept in a local
            database inside the app's own data folder, and never synced anywhere.
          </li>
          <li>
            <strong className="text-white">Settings</strong> (theme, temperature,
            chat width) are stored locally alongside it.
          </li>
        </ul>

        <h2 className="pt-2 text-xl font-semibold text-white">
          Network activity
        </h2>
        <p>
          The app makes no network requests to run. The inference runtime and OCR
          engine are bundled, not downloaded. There are three ways it can reach
          the network, all of them things you start:
        </p>
        <ul className="list-disc space-y-1 pl-5 marker:text-white/40">
          <li>
            Downloading a model from <strong className="text-white">Hugging Face</strong>,
            if you use the in-app download button.
          </li>
          <li>
            <strong className="text-white">Web search</strong>, when you enable it
            — queries go to the search backend you configured, by default one
            running on this same machine.
          </li>
          <li>
            Opening a link, which hands it to your normal browser.
          </li>
        </ul>
        <p>
          There is no account system, no analytics, no telemetry, and no automatic
          update check.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">Your control</h2>
        <p>
          Settings and linked models can be cleared from the in-app Settings
          panel. "Forget" removes a model from the app's list; the underlying file
          is only deleted when the app downloaded it itself. Uninstalling removes
          the app's data folder along with your chat history.
        </p>

        <h2 className="pt-2 text-xl font-semibold text-white">Contact</h2>
        <p>
          Questions about this policy? Open an issue on{' '}
          <button
            type="button"
            onClick={() => openExternal('https://github.com/washim1982/promptly-Imaginarium/issues')}
            className="text-[var(--color-teal)] underline"
          >
            GitHub
          </button>
          .
        </p>
      </section>
    </div>
  );
}
