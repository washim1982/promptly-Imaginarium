// The assistant beside the document: ask the local model about whatever is
// open.
//
// The document's text is pulled fresh from disk on every question, so the
// answer is about the file as it stands — including edits you just saved. It
// goes to the model wrapped as untrusted source data, the same guard the chat
// agent puts around tool output: a spreadsheet cell or a slide is content, and
// content that says "ignore your instructions" is still just content.

import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RefreshCw, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import Markdown from '../chat/Markdown';
import { useLlm } from '../../state/LlmContext';
import { cleanError } from '../../lib/desktop';
import { estimateTokens, inputTokenBudget, untrustedToolMessage } from '../../lib/agent/context';
import { findReviewModel, REVIEW_MODEL_LABEL, stripThinking } from '../../lib/svn/review';
import { officeApi, type DocumentText } from '../../lib/office/api';
import { looksDegenerate } from '../../lib/office/degenerate';

const SYSTEM = `You are reading a document a user has open in a desktop office app. Answer questions about it.

- Work only from the document provided. If it does not say, say so — do not invent figures, names or dates.
- Quote the sheet, slide or heading a fact came from, so the user can check it.
- For spreadsheets: cells arrive as tab-separated rows under a heading per sheet. The first row is usually the header.
- Be concise. Use a short list or a small table when it genuinely helps; otherwise plain sentences.`;

const QUICK = [
  { label: 'Summarize', prompt: 'Summarize this document in a few sentences, then list its key points.' },
  { label: 'Describe', prompt: 'Describe how this document is structured and what it is for.' },
  { label: 'Key numbers', prompt: 'Pull out the important numbers, totals and trends. Say where each one comes from.' },
  { label: 'Problems', prompt: 'What looks wrong, inconsistent, missing or out of date here?' },
];

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The whole prompt, kept inside the model's input budget.
 *
 * Budgeting the document alone is not enough: the system prompt, the wrapper
 * and the earlier turns all take room, and the reply has to fit in the same
 * window. Overflow does not fail loudly — the model starts emitting token
 * salad — so history is dropped oldest-first and then the document is clipped
 * until the estimate fits, and the caller is told what was cut.
 */
function buildPrompt(
  doc: DocumentText,
  history: Turn[],
  question: string,
  fileName: string,
  budget: number,
): { prompt: string; usedTokens: number; droppedTurns: number; clippedDoc: boolean } {
  const tokens = (text: string) => estimateTokens([{ role: 'user', content: text }]);
  const fixed = tokens(SYSTEM) + tokens(question) + 64; // 64: chat template overhead

  let turns = history.slice(-6);
  let docText = doc.text;
  let clippedDoc = false;
  const assemble = () => {
    const wrapped = untrustedToolMessage(`the open document ${fileName}`, docText).content;
    const earlier = turns.map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`).join('\n\n');
    return [
      wrapped,
      doc.truncated || clippedDoc ? '(Only part of the document is shown — it was clipped to fit.)' : '',
      earlier ? `Earlier in this conversation:\n${earlier}` : '',
      `User's question: ${question}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  };

  // Earlier turns go first: the document is what the question is about.
  let body = assemble();
  while (turns.length && fixed + tokens(body) > budget) {
    turns = turns.slice(1);
    body = assemble();
  }
  // Then the document itself, down to a floor worth sending at all.
  while (docText.length > 500 && fixed + tokens(body) > budget) {
    docText = docText.slice(0, Math.floor(docText.length * 0.75));
    clippedDoc = true;
    body = assemble();
  }

  return {
    prompt: body,
    usedTokens: fixed + tokens(body),
    droppedTurns: Math.min(history.length, 6) - turns.length,
    clippedDoc,
  };
}


export default function AssistantPanel({ file, fileName }: { file: string | null; fileName: string }) {
  const llm = useLlm();
  const latest = useRef(llm);
  latest.current = llm;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [docInfo, setDocInfo] = useState<DocumentText | null>(null);
  const [fit, setFit] = useState<{ used: number; budget: number; droppedTurns: number; clipped: boolean } | null>(null);
  const [lastQuestion, setLastQuestion] = useState('');
  const stopped = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A different file is a different conversation.
  useEffect(() => {
    setTurns([]);
    setError('');
    setDocInfo(null);
    setFit(null);
  }, [file]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  const ask = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || !file || busy) return;

    const current = latest.current;
    if (current.isGenerating) {
      setError('The model is busy with another task. Wait for it to finish, then try again.');
      return;
    }

    setError('');
    setQuestion('');
    setLastQuestion(prompt);
    setTurns((t) => [...t, { role: 'user', text: prompt }, { role: 'assistant', text: '' }]);
    setBusy(true);
    stopped.current = false;

    try {
      // Make sure a model is actually loaded before reading the file.
      if (current.status !== 'ready') {
        const target = findReviewModel(current.models);
        if (!target) {
          throw new Error(`No model is loaded. Add ${REVIEW_MODEL_LABEL} in Chat, then come back.`);
        }
        const ok = await current.loadModel({ type: 'library', id: target.id });
        if (!ok) throw new Error(`Couldn't load ${target.label}: ${latest.current.error ?? 'unknown error'}`);
      }

      const { maxNumTokens, maxOutputTokens } = latest.current.settings;
      const budget = inputTokenBudget(maxNumTokens, maxOutputTokens);
      // Read generously, then let buildPrompt cut it down to what actually fits.
      const doc = await officeApi.extractText(file, Math.floor(budget / 0.3));
      setDocInfo(doc);
      if (!doc.text.trim()) throw new Error('There is no readable text in this document.');

      const history = turns.filter((t) => t.text.trim());
      const built = buildPrompt(doc, history, prompt, fileName, budget);
      setFit({ used: built.usedTokens, budget, droppedTurns: built.droppedTurns, clipped: built.clippedDoc || doc.truncated });

      let raw = '';
      for await (const token of latest.current.generate(built.prompt, SYSTEM)) {
        if (stopped.current) break;
        raw += token;
        const shown = stripThinking(raw);
        setTurns((t) => {
          const next = [...t];
          next[next.length - 1] = { role: 'assistant', text: shown };
          return next;
        });
      }
      const finalText = stripThinking(raw).trim();
      // A degenerate reply is worse than no reply: it looks like an answer.
      const broken = looksDegenerate(finalText, doc.text);
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = {
          role: 'assistant',
          text: broken
            ? '_The model produced unusable output for this prompt. Try again, or switch to a different model in Chat._'
            : finalText || (stopped.current ? '_Stopped._' : '_The model returned nothing._'),
        };
        return next;
      });
      if (broken) setError('That answer came back as gibberish, so it was discarded rather than shown.');
    } catch (err) {
      setError(cleanError(err));
      setTurns((t) => t.slice(0, -1)); // drop the empty assistant turn
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="ms-assistant">
      <header className="ms-assistant-head">
        <Bot size={15} className="text-[var(--color-neon)]" />
        <span>Assistant</span>
        {llm.activeModel && <span className="ms-model" title={llm.activeModel.label}>{llm.activeModel.label}</span>}
        <span className="flex-1" />
        {turns.length > 0 && !busy && (
          <button className="ms-icon-button" onClick={() => setTurns([])} title="Clear" aria-label="Clear conversation">
            <Trash2 size={13} />
          </button>
        )}
      </header>

      {!file ? (
        <p className="ms-hint">Open a document and ask about it here.</p>
      ) : (
        <>
          <div className="ms-quick">
            {QUICK.map((q) => (
              <button key={q.label} disabled={busy} onClick={() => void ask(q.prompt)}>
                <Sparkles size={11} /> {q.label}
              </button>
            ))}
          </div>

          <div className="ms-chat">
            {!turns.length && (
              <p className="ms-hint">
                Reading <strong>{fileName}</strong>. Ask anything about it, or use a shortcut above.
              </p>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={`ms-turn ${turn.role}`}>
                {turn.role === 'user' ? (
                  <p>{turn.text}</p>
                ) : turn.text ? (
                  <Markdown>{turn.text}</Markdown>
                ) : (
                  <p className="ms-thinking">
                    <Loader2 className="inline animate-spin" size={12} /> Reading the document…
                  </p>
                )}
              </div>
            ))}
            {error && <p className="ms-assistant-error">{error}</p>}
            {fit && !busy && (fit.clipped || fit.droppedTurns > 0) && (
              <p className="ms-assistant-note">
                {fit.clipped &&
                  `The document is ${(docInfo?.fullLength ?? 0).toLocaleString()} characters; only part of it fitted. `}
                {fit.droppedTurns > 0 && `${fit.droppedTurns} earlier turn(s) were dropped to make room. `}
                Context used: {fit.used.toLocaleString()} of {fit.budget.toLocaleString()} tokens.
              </p>
            )}
            {turns.length > 0 && !busy && lastQuestion && (
              <button className="ms-regen" onClick={() => void ask(lastQuestion)}>
                <RefreshCw size={11} /> Ask again
              </button>
            )}
            <div ref={endRef} />
          </div>

          <div className="ms-ask">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(question);
                }
              }}
              rows={2}
              placeholder={`Ask about ${fileName}…`}
              disabled={busy}
            />
            {busy ? (
              <button className="ms-send stop" onClick={() => { stopped.current = true; llm.cancel(); }} aria-label="Stop">
                <Square size={13} />
              </button>
            ) : (
              <button className="ms-send" onClick={() => void ask(question)} disabled={!question.trim()} aria-label="Send">
                <Send size={14} />
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
