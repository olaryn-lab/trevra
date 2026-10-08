import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureHeaderProblem,
  captureSignatureHex,
  captureSignatureMatches,
  rawCaptureBody,
  readCaptureHeaders
} from './signature.js';

const BODY = Buffer.from('{"kind":"demo_request","person":{"email":"a@acme.com"}}');

describe('capture signature', () => {
  it('signs timestamp.idempotencyKey.rawBody exactly like the documented recipe', () => {
    const expected = createHmac('sha256', 'trv_capture_test')
      .update(`1760000000.form-key-0001.${BODY.toString('utf8')}`)
      .digest('hex');
    expect(captureSignatureHex('trv_capture_test', '1760000000', 'form-key-0001', BODY)).toBe(
      expected
    );
  });

  it('reads headers case-insensitively and strips the sha256= prefix', () => {
    const headers = readCaptureHeaders({
      'x-trevra-source': ' cap_1 ',
      'x-trevra-timestamp': '1760000000',
      'x-trevra-idempotency-key': 'form-key-0001',
      'x-trevra-signature': 'SHA256=abc123'
    });
    expect(headers).toEqual({
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature: 'abc123'
    });
  });

  it('accepts the active or previous secret and rejects anything else', () => {
    const signature = captureSignatureHex('previous', '1760000000', 'form-key-0001', BODY);
    const headers = {
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature
    };
    expect(captureSignatureMatches(['active', 'previous'], headers, BODY)).toBe(true);
    expect(captureSignatureMatches(['active'], headers, BODY)).toBe(false);
    expect(captureSignatureMatches(['previous'], { ...headers, signature: 'zz' }, BODY)).toBe(
      false
    );
  });

  it('reports header problems in the order intake has always applied them', () => {
    const base = {
      sourceId: 'cap_1',
      timestampRaw: '1760000000',
      idempotencyKey: 'form-key-0001',
      signature: ''
    };
    expect(captureHeaderProblem({ ...base, idempotencyKey: 'short' }, 1760000000)).toEqual({
      status: 400,
      error: 'A valid X-Trevra-Idempotency-Key is required'
    });
    expect(captureHeaderProblem({ ...base, timestampRaw: '17.5' }, 1760000000)).toEqual({
      status: 401,
      error: 'Invalid capture timestamp'
    });
    expect(captureHeaderProblem(base, 1760000301)).toEqual({
      status: 401,
      error: 'Capture timestamp is outside the replay window'
    });
    expect(captureHeaderProblem(base, 1760000300)).toBeNull();
  });

  it('treats a non-buffer body as UTF-8 text', () => {
    expect(rawCaptureBody(undefined).length).toBe(0);
    expect(rawCaptureBody('{}').toString('utf8')).toBe('{}');
    expect(rawCaptureBody(BODY)).toBe(BODY);
  });
});
