import {
  API_PREFIX,
  normalizeScanUrl,
  type RunnerSession,
} from '../shared/scan';
import { saveSession } from './state';

declare const __LOCAL_ORIGINS__: string[];

const allowedOrigins = new Set([
  'https://vizlinx.com',
  'https://www.vizlinx.com',
  ...__LOCAL_ORIGINS__,
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
    respond({ ok: true, protocolVersion: 2 });
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
  let lockAcquired = false;
  let waitingForRunner = false;
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
    // Token rotation stops the previous runner; wait for its last persisted outbox
    // before replacing the session so its final write cannot restore the old token.
    waitingForRunner = true;
    await navigator.locks.request(
      'vizlinx:runner',
      { signal: AbortSignal.timeout(25_000) },
      async () => {
        lockAcquired = true;
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
      },
    );
  })().catch(() =>
    respond({
      ok: false,
      error:
        waitingForRunner && !lockAcquired
          ? 'Jiná skenovací karta je stále aktivní. Pozastavte ji a zkuste připojení znovu.'
          : 'Párování se nepodařilo. Vytvořte na webu nové spojení.',
    }),
  );
  return true;
});
