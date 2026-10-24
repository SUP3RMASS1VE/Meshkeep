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
}
module.exports = config;
