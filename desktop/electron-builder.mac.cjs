// Explicit opt-in: unsigned local builds still work, while release signing
// fails the build if the supplied Developer ID certificate cannot be used.
const config = structuredClone(require('./package.json').build);
if (process.env.CSC_LINK || process.env.CSC_NAME) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  delete config.mac.identity;
  config.forceCodeSigning = true;
  config.mac.hardenedRuntime = true;
  config.mac.entitlements = 'build/entitlements.mac.plist';
  config.mac.entitlementsInherit = 'build/entitlements.mac.plist';
} else {
  // Seal the final bundle even without a Developer ID certificate. Leaving
  // Electron's original linker signature causes macOS to report it as damaged.
  config.afterPack = require('./sign-mac-adhoc.cjs');
}
module.exports = config;
