// Shared Google-account status for the Email and Google Drive sections, so
// connecting in one updates the other without a refetch.

import { useEffect, useSyncExternalStore } from 'react';
import { googleApi, type GoogleStatus } from '../../../lib/google';

let current: GoogleStatus | null = null;
let loadError = '';
const listeners = new Set<() => void>();

function publish(next: GoogleStatus | null, error = '') {
  current = next;
  loadError = error;
  listeners.forEach((l) => l());
}

export async function refreshGoogle(): Promise<void> {
  try {
    publish(await googleApi.status());
  } catch (err) {
    publish(current, (err as Error).message);
  }
}

export const setGoogleStatus = (s: GoogleStatus) => publish(s);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useGoogle(): { status: GoogleStatus | null; error: string } {
  const status = useSyncExternalStore(subscribe, () => current);
  const error = useSyncExternalStore(subscribe, () => loadError);
  useEffect(() => {
    if (!current) void refreshGoogle();
  }, []);
  return { status, error };
}
