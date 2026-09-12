import {
  API_PREFIX,
  normalizeScanUrl,
  type RunnerSession,
} from '../shared/scan';
import { saveSession } from './state';

declare const __DEV__: boolean;

const allowedOrigins = new Set([
  'https://vizlinx.com',
  'https://www.vizlinx.com',
  ...(__DEV__ ? ['http://127.0.0.1:8797', 'http://localhost:8797'] : []),
]);

async function openRunner(id?: string) {
  const suffix = id ? `?scan=${encodeURIComponent(id)}` : '';
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`runner.html${suffix}`),
  });
}

chrome.action.onClicked.addListener(() => {
  void chrome.storage.local
    .get('lastScanId')
    .then(({ lastScanId }) =>
      openRunner(typeof lastScanId === 'string' ? lastScanId : undefined),
    );
});

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (
    !sender.origin ||
    !allowedOrigins.has(sender.origin) ||
    !sender.url ||
    new URL(sender.url).origin !== sender.origin ||
    sender.frameId !== 0
  ) {
    respond({ ok: false, error: 'Untrusted sender.' });
    return false;
  }
  if (message?.type === 'vizlinx:ping') {
    respond({ ok: true });
    return false;
  }
  if (
    message?.type !== 'vizlinx:pair' ||
    typeof message.ticket !== 'string' ||
    message.ticket.length < 16 ||
    message.ticket.length > 256
  ) {
    respond({ ok: false, error: 'Invalid pairing message.' });
    return false;
  }
  const apiOrigin = sender.origin;
  void (async () => {
    const response = await fetch(`${apiOrigin}${API_PREFIX}/runner/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: message.ticket }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error('Pairing failed. Create a new ticket on the website.');
    const session = (await response.json()) as RunnerSession;
    if (
      !session.token ||
      !session.scan?.id ||
      !Array.isArray(session.scan.sites) ||
      session.scan.sites.length > 3
    )
      throw new Error('Invalid pairing response.');
    for (const site of session.scan.sites) {
      if (new URL(normalizeScanUrl(site.seedUrl)).origin !== site.origin)
        throw new Error('Invalid scan scope.');
    }
    await saveSession(apiOrigin, session);
    await openRunner(session.scan.id);
    respond({ ok: true });
  })().catch(() =>
    respond({
      ok: false,
      error: 'Párování se nepodařilo. Vytvořte na webu nové spojení.',
    }),
  );
  return true;
});
