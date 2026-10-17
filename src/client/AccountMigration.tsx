import { useEffect, useState } from 'react';
import { Button } from './ui/primitives';

export function AccountMigration() {
  const [status, setStatus] = useState<{ enabled: boolean; linked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void fetch('/api/auth/isolated-link/status')
      .then(async (response) => {
        if (response.ok) setStatus(await response.json());
      })
      .catch(() => {});
    if (new URLSearchParams(window.location.search).get('accountLink') === 'failed')
      setError('Connection failed or expired. Keep your original session signed in and try again.');
  }, []);
  if (!status?.enabled) return null;
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/isolated-link/begin', { method: 'POST' });
      if (!response.ok) throw new Error('Could not start connection. Try again.');
      const body = (await response.json()) as { url: string };
      window.location.assign(body.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not start connection.');
      setBusy(false);
    }
  }
  return (
    <section className="page-panel" aria-labelledby="account-migration-heading">
      <div className="section-heading">
        <h2 id="account-migration-heading">Account sign-in</h2>
      </div>
      <p>
        Connect your isolated Authward account to keep using this Trevra account and its workspaces.
        You will sign in again to prove that you own it.
      </p>
      {status.linked ? (
        <p role="status">Isolated account connected.</p>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Opening sign-in…' : 'Connect isolated account'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
