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
    let contents = mod.modResults.contents;
    if (!contents.includes('struct KiloAppIntentsPackage: AppIntentsPackage')) {
      for (const name of ['AppIntents', 'KiloAppActions']) {
        const declaration = `import ${name}\n`;
        if (!contents.includes(declaration)) {
          contents = declaration + contents;
        }
      }
      mod.modResults.contents = contents.trimEnd() + '\n' + PACKAGE;
    }
    return mod;
  });
};
