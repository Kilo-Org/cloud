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

  # SDK 26.4 supplies transcript token counting. SDK 27 additionally supplies
  # reported usage and the new error types; do not make those a build requirement.
  # A toolchain without the FoundationModels API still builds the app: the pod
  # compiles an empty stub instead, the module never registers, and the JS layer
  # reports the model as unavailable on that machine.
  sdk_version = `xcrun --sdk iphoneos --show-sdk-version`.strip
  sdk_supports_foundation_models =
    !sdk_version.empty? && Gem::Version.new(sdk_version) >= Gem::Version.new('26.4')
  xcconfig = { 'DEFINES_MODULE' => 'YES' }
  if sdk_supports_foundation_models
    s.source_files = '**/*.swift'
    s.weak_frameworks = 'FoundationModels'
    if Gem::Version.new(sdk_version) >= Gem::Version.new('27.0')
      xcconfig['OTHER_SWIFT_FLAGS'] = '$(inherited) -DKILO_FOUNDATION_MODELS_USAGE'
    end
  else
    Pod::UI.warn(
      'KiloAppleModel: the selected Xcode SDK is ' \
      "#{sdk_version.empty? ? 'unknown' : sdk_version}, so the on-device Apple model " \
      'is unavailable in this build. Use Xcode with the iOS 26.4 SDK or newer to enable it.'
    )
    s.source_files = 'stub/**/*.swift'
  end
  s.pod_target_xcconfig = xcconfig
end
