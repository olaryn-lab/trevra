import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { getPublicConfig } from './api';
import { Panel } from './ui/layout';
import { Button } from './ui/primitives';
import { registerTrevraPasskey } from './native-product-passkey';

export function NativeTrevraPasskeySettings() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    void getPublicConfig()
      .then((config) => setEnabled(config.passkeyAuthEnabled === true))
      .catch(() => undefined);
  }, []);
  if (!enabled) return null;
  return (
    <Panel
      title="Passkeys"
      description="Sign in directly to Trevra on this device. Existing Olaryn passkeys are separate."
    >
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(null);
          void registerTrevraPasskey()
            .then(() =>
              setMessage({
                text: 'Passkey saved. You can use it next time you sign in.',
                error: false
              })
            )
            .catch((error) =>
              setMessage({
                text: error instanceof Error ? error.message : 'Passkey setup failed',
                error: true
              })
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />} Add a Trevra
        passkey
      </Button>
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </Panel>
  );
}
