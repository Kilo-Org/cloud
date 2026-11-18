Pod::Spec.new do |s|
  s.name = 'KiloSurfaceGeometry'
  s.version = '1.0.0'
  s.summary = 'Root-local visible surface geometry'
  s.description = 'Local Expo module for native surface and docked keyboard geometry.'
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
