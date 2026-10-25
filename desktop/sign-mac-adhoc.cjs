'use strict';
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {signAsync} = require('@electron/osx-sign');

module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await signAsync({
    app,
    identity: '-',
    identityValidation: false,
    platform: 'darwin',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      entitlements: path.join(__dirname, 'build/entitlements.mac.plist'),
      timestamp: 'none',
    }),
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {stdio: 'inherit'});
};
