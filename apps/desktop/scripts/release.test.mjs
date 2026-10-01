import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseConfig, verifyArtifact } from './release.mjs';

// Public minisign-verify vectors; never used as production trust.
const rawKey = 'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
const key = Buffer.from(rawKey).toString('base64');
const rawSignature = 'untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==';
const signature = Buffer.from(rawSignature).toString('base64');
const env = {
  VOXLY_DESKTOP_UPDATE_ENDPOINT: 'https://github.com/owner/repo/releases/latest/download/latest.json',
  VOXLY_DESKTOP_UPDATER_PUBLIC_KEY: key,
  VOXLY_DESKTOP_RELEASE_VERSION: '0.1.0',
  VOXLY_DESKTOP_CERTIFICATE_THUMBPRINT: 'a'.repeat(40),
  VOXLY_DESKTOP_TIMESTAMP_URL: 'https://timestamp.example',
  VOXLY_DESKTOP_PUBLISHER: 'Example distributor'
};

test('production config requires fixed HTTPS trust, signing identity and matching stable versions', () => {
  const config = releaseConfig(env, ['0.1.0', '0.1.0', '0.1.0']);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.pubkey, key);
  assert.deepEqual(config.bundle.windows.webviewInstallMode, { type: 'offlineInstaller' });
  for (const field of Object.keys(env)) {
    assert.throws(() => releaseConfig({ ...env, [field]: '' }, ['0.1.0', '0.1.0', '0.1.0']), field);
  }
  for (const endpoint of ['http://github.com/latest.json', 'https://user@github.com/latest.json', 'https://github.com/latest.json#part']) {
    assert.throws(() => releaseConfig({ ...env, VOXLY_DESKTOP_UPDATE_ENDPOINT: endpoint }, ['0.1.0', '0.1.0', '0.1.0']));
  }
  assert.throws(() => releaseConfig(env, ['0.1.0', '0.2.0', '0.1.0']));
  assert.throws(() => releaseConfig({ ...env, VOXLY_DESKTOP_RELEASE_VERSION: '0.1.0-beta' }, ['0.1.0-beta']));
  assert.throws(() => releaseConfig({ ...env, VOXLY_DESKTOP_PUBLISHER: 'Voxly' }, ['0.1.0']));
});

test('release artifacts must verify against the embedded public key before manifest generation', () => {
  verifyArtifact(Buffer.from('test'), signature, key);
  assert.throws(() => verifyArtifact(Buffer.from('Test'), signature, key));
  assert.throws(() => verifyArtifact(Buffer.from('test'), 'invalid', key));
  assert.throws(() => verifyArtifact(Buffer.from('test'), signature, Buffer.from(rawKey.replace('RWQf6LRCGA9i53', 'RWQf6LRCGA9i54')).toString('base64')));
  const tamperedComment = Buffer.from(rawSignature.replace('file:test', 'file:other')).toString('base64');
  assert.throws(() => verifyArtifact(Buffer.from('test'), tamperedComment, key));
});
