const { withAppDelegate } = require('expo/config-plugins');

const PACKAGE = `
@available(iOS 17.0, *)
struct KiloAppIntentsPackage: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] {
    [KiloAppActionsPackage.self]
  }
}
`;

module.exports = function withKiloAppIntentsPackage(config) {
  return withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('withKiloAppIntentsPackage: AppDelegate must be Swift.');
    }
    let contents = mod.modResults.contents.replace(
      /^import KiloAppActions$/m,
      'internal import KiloAppActions'
    );
    for (const declaration of ['import AppIntents\n', 'internal import KiloAppActions\n']) {
      if (!contents.includes(declaration)) {
        contents = declaration + contents;
      }
    }
    if (!contents.includes('struct KiloAppIntentsPackage: AppIntentsPackage')) {
      contents = contents.trimEnd() + '\n' + PACKAGE;
    }
    mod.modResults.contents = contents;
    return mod;
  });
};
