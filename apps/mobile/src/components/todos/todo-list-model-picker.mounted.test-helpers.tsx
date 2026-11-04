import {
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

type Route = { pathname: string; params: Record<string, string> };
type Router = {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
};
type RouteContextValue = { router: Router; params: Record<string, string>; focused: boolean };

const RouteContext = createContext<RouteContextValue | null>(null);

function useRouteContext() {
  const value = useContext(RouteContext);
  if (!value) {
    throw new Error('Missing picker test route context');
  }
  return value;
}

export function useTestRouter() {
  return useRouteContext().router;
}

export function useTestLocalSearchParams() {
  return useRouteContext().params;
}

export function useTestFocusEffect(effect: () => undefined | (() => void)) {
  const { focused } = useRouteContext();
  useEffect(() => (focused ? effect() : undefined), [effect, focused]);
}

/**
 * Models a navigation stack and focus: a pushed route mounts above the caller,
 * `back` unmounts it, and only the top route is focused. It does not model
 * native formSheet presentation.
 */
export function PickerRouteStack({
  settings,
  picker,
}: Readonly<{ settings: ReactNode; picker: ReactNode }>) {
  const [routes, setRoutes] = useState<Route[]>([{ pathname: 'list-settings', params: {} }]);
  const router = useMemo<Router>(
    () => ({
      push: href => {
        const url = new URL(href, 'https://test.invalid');
        if (url.pathname !== '/(app)/agent-chat/model-picker') {
          throw new Error(`Unexpected route push: ${url.pathname}`);
        }
        const params = Object.fromEntries(url.searchParams);
        setRoutes(current => [...current, { pathname: url.pathname, params }]);
      },
      replace: href => {
        const url = new URL(href, 'https://test.invalid');
        const params = Object.fromEntries(url.searchParams);
        setRoutes(current => [...current.slice(0, -1), { pathname: url.pathname, params }]);
      },
      back: () => {
        setRoutes(current => current.slice(0, -1));
      },
    }),
    []
  );

  return createElement(
    Fragment,
    null,
    routes.map((route, index) =>
      createElement(
        RouteContext.Provider,
        {
          key: index,
          value: { router, params: route.params, focused: index === routes.length - 1 },
        },
        createElement(
          'TestRoute',
          { name: route.pathname, focused: index === routes.length - 1 },
          index === 0 ? settings : picker
        )
      )
    )
  );
}

export function NativeTextInput({
  defaultValue = '',
  onChangeText,
  ref,
  ...props
}: Readonly<{
  defaultValue?: string;
  onChangeText?: (value: string) => void;
  ref?: Ref<{ clear: () => void }>;
  [key: string]: unknown;
}>) {
  const [value, setValue] = useState(defaultValue);
  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        setValue('');
      },
    }),
    []
  );

  return createElement('TextInput', {
    ...props,
    value,
    onChangeText: (next: string) => {
      setValue(next);
      onChangeText?.(next);
    },
  });
}

export function NativeSheetHeader({
  title,
  doneLabel = 'Done',
  onDone,
  disabled,
}: Readonly<{ title: string; doneLabel?: string; onDone: () => void; disabled?: boolean }>) {
  return createElement(
    'SheetHeader',
    { title },
    createElement(
      'Pressable',
      { accessibilityLabel: doneLabel, accessibilityRole: 'button', onPress: onDone, disabled },
      createElement('Text', null, doneLabel)
    )
  );
}

export function NativeFlashList<T>({
  data,
  renderItem,
  keyExtractor,
}: Readonly<{
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor: (item: T, index: number) => string;
}>) {
  return createElement(
    'FlashList',
    null,
    data.map((item, index) =>
      createElement(Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))
    )
  );
}
