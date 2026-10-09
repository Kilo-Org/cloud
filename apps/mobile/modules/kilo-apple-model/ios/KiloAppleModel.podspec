Pod::Spec.new do |s|
  s.name = 'KiloAppleModel'
  s.version = '1.0.0'
  s.summary = 'Inference-only Apple Foundation Models bridge for Quick Chat'
  s.description = 'Rebuilds the supplied transcript for each request and streams on-device text inference without storing chats or executing tools.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Kilo'
  s.homepage = 'https://github.com/Kilo-Org/cloud'
  s.source = { :git => 'https://github.com/Kilo-Org/cloud.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.weak_frameworks = 'FoundationModels'

  # SDK 26.4 supplies transcript token counting. SDK 27 additionally supplies
  # reported usage and the new error types; do not make those a build requirement.
  # Use the selected Xcode's iPhoneOS SDK, the same toolchain used for pod builds.
  sdk_version = `xcrun --sdk iphoneos --show-sdk-version`.strip
  if sdk_version.empty? || Gem::Version.new(sdk_version) < Gem::Version.new('26.4')
    raise 'KiloAppleModel requires the iOS 26.4 SDK or newer; the deployment target remains iOS 16.4.'
  end
  xcconfig = { 'DEFINES_MODULE' => 'YES' }
  if Gem::Version.new(sdk_version) >= Gem::Version.new('27.0')
    xcconfig['OTHER_SWIFT_FLAGS'] = '$(inherited) -DKILO_FOUNDATION_MODELS_USAGE'
  end
  s.pod_target_xcconfig = xcconfig
end
