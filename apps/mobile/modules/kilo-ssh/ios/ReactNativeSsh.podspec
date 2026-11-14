Pod::Spec.new do |s|
  s.name           = 'ReactNativeSsh'
  s.version        = '1.0.0'
  s.summary        = 'SSH client with a Rust core, uniffi bindings and a terminal view'
  s.description    = 'Connects, authenticates and runs shells, commands, SFTP transfers and port forwards through a Rust core reached over uniffi.'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'Kilo'
  s.homepage       = 'https://github.com/Kilo-Org/cloud'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/Kilo-Org/cloud.git' }
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

  # The Rust core ships as a static-library xcframework. CocoaPods reads this
  # path at pod install and silently drops the bundle when it is absent, so
  # scripts/build-native.sh must run before pod install: `pnpm ios` and the
  # eas-build-post-install hook both do. The iOS job of mobile-native-build.yml
  # runs it before its prebuild too.
  #
  # No file pattern may reach into Frameworks/: an exclude_files entry that
  # matches the bundle (e.g. "Frameworks/**/*") removes it from the file
  # accessor, so no copy phase and no link flag are generated and the app fails
  # to link the uniffi symbols.
  s.vendored_frameworks = 'Frameworks/SshCore.xcframework'
  s.source_files = '*.{h,m,mm,swift}', 'Terminal/**/*.swift', 'Generated/**/*.{h,swift}'
end