// Compiled instead of the real module when the selected Xcode SDK has no
// FoundationModels API. Registering nothing is what makes the JS layer report
// the on-device Apple model as unavailable rather than failing the build.
import Foundation
