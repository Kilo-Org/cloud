Pod::Spec.new do |s|
  s.name = 'NotificationFocusFilter'
  s.version = '1.0.0'
  s.summary = 'Per-Focus agent notification choice'
  s.description = 'Local Expo module that exposes the agent-progress Focus filter choice to JS.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Kilo'
  s.homepage = 'https://github.com/Kilo-Org/cloud'
  s.source = { :git => 'https://github.com/Kilo-Org/cloud.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
