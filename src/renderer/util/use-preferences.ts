import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreferencesFile, PreferencesPatch } from '@shared/preferences';
import { ipc } from '../ipc-client';

/**
 * Reactive view onto the preferences file. We don't push prefs changes via an
 * IPC broadcast (yet) — instead, every save bumps a local refresh counter
 * and components re-fetch. The PreferencesModal is the only writer; everyone
 * else only reads.
 */
const subscribers = new Set<() => void>();

function notifyAll() {
  for (const sub of subscribers) sub();
}

export function usePreferences(): {
  prefs: PreferencesFile | null;
  reload: () => Promise<void>;
} {
  const [prefs, setPrefs] = useState<PreferencesFile | null>(null);
  const reloadSequence = useRef(0);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const next = await ipc.getPreferences();
    if (sequence === reloadSequence.current) setPrefs(next);
  }, []);

  useEffect(() => {
    void reload();
    const sub = () => void reload();
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, [reload]);

  return { prefs, reload };
}

export async function savePreferencePatch(patch: PreferencesPatch): Promise<void> {
  await ipc.patchPreferences(patch);
  notifyAll();
}
