Pod::Spec.new do |s|
  s.name = 'HomeWidgetRefresh'
  s.version = '1.0.0'
  s.summary = 'Authenticated background Home widget refresh'
  s.description = 'Shared protected authentication and WidgetKit refresh transport.'
  s.license = { :type => 'Proprietary' }
  s.author = 'Kilo'
  s.homepage = 'https://github.com/Kilo-Org/cloud'
  s.source = { :git => 'https://github.com/Kilo-Org/cloud.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'HomeWidgetRefreshModule.swift', 'HomeWidgetRefreshStore.swift'
  s.frameworks = 'Security', 'WidgetKit'
end
