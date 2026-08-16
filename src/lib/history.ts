// Local chat history persistence in IndexedDB. Fully client-side, no auth, no
// server — each browser keeps its own private history (matches the app's
// privacy model). Plus JSON export/import for backup & portability.

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  // Web sources an assistant used (present only for web-search-grounded replies).
  sources?: { title: string; url: string; content: string }[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export type ConversationMeta = Omit<Conversation, 'messages'>;

const DB_NAME = 'imaginarium';
const STORE = 'conversations';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putConversation(c: Conversation): Promise<void> {
  await tx('readwrite', (s) => s.put(c));
}

export async function getConversation(
  id: string,
): Promise<Conversation | undefined> {
  return tx<Conversation | undefined>('readonly', (s) => s.get(id));
}

export async function deleteConversation(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function getAllConversations(): Promise<Conversation[]> {
  const all = await tx<Conversation[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const all = await getAllConversations();
  return all.map(({ messages: _messages, ...meta }) => meta);
}

// ---- Export / Import (backup & portability without a server) --------------

export async function exportConversations(): Promise<void> {
  const all = await getAllConversations();
  const blob = new Blob([JSON.stringify({ version: 1, conversations: all }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `imaginarium-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importConversations(file: File): Promise<number> {
  const text = await file.text();
  const data = JSON.parse(text);
  const list: Conversation[] = Array.isArray(data)
    ? data
    : (data?.conversations ?? []);
  let count = 0;
  for (const c of list) {
    if (c && c.id && Array.isArray(c.messages)) {
      await putConversation(c);
      count++;
    }
  }
  return count;
}
