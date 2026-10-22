import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { getPublicConfig } from './api';
import { registerTrevraPasskey } from './native-product-passkey';

export function NativeTrevraPasskeySettings() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void getPublicConfig()
      .then((config) => setEnabled(config.passkeyAuthEnabled === true))
      .catch(() => undefined);
  }, []);
  if (!enabled) return null;
  return (
    <section className="ui-panel" style={{ padding: 20 }}>
      <h3>Passkeys</h3>
      <p>Save a passkey for app.usetrevra.com. Existing Olaryn passkeys are not imported.</p>
      <button
        type="button"
        className="primary-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage('');
          void registerTrevraPasskey()
            .then(() => setMessage('Passkey saved. You can use it next time you sign in.'))
            .catch((error) =>
              setMessage(error instanceof Error ? error.message : 'Passkey setup failed')
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />} Add a Trevra
        passkey
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
