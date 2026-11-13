require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ReactNativeSsh'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  spm_dependency(s,
    url: 'https://github.com/migueldeicaza/SwiftTerm',
    requirement: { kind: 'exactVersion', version: '1.10.1' },
    products: ['SwiftTerm']
  )

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/Generated"',
    'SWIFT_INCLUDE_PATHS' => '"$(PODS_TARGET_SRCROOT)/Generated"',
  }

  # The Rust core ships as a static-library xcframework. CocoaPods copies the
  # slice matching the build platform and architectures and links its archive.
  #
  # No file pattern may reach into Frameworks/: an exclude_files entry that
  # matches the bundle (e.g. "Frameworks/**/*") removes it from the file
  # accessor, so no copy phase and no link flag are generated and the app fails
  # to link the uniffi symbols.
  s.vendored_frameworks = 'Frameworks/SshCore.xcframework'
  s.source_files = '*.{h,m,mm,swift}', 'Terminal/**/*.swift', 'Generated/**/*.{h,swift}'
end
