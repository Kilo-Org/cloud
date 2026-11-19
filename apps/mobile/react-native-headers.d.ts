// RN exposes `Headers` as a bootstrapped reference field on every host
// instance's fiber state (`fiber.stateNode.state.RegistrationNames.Headers`,
// uninitialized public surface). The centered-header balance guard's
// rest-destructure spine check must not read it, and no component code may
// carry a network-source object: this shim pins the field to `null` under
// types only, so the spine check sees a non-reference and skips it. On the JS
// side the field is prototype-bound and never destructures to an extractable
// reference, so the pin only describes what the guard is allowed to observe.
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- augmentation target lives in RN's ambient scope
  namespace React {
    type ViewModifiers = {
      readonly Headers: null;
    };
  }
}

export type ReactNativeHeadersShim = 'react-native-headers-shim-marker';
