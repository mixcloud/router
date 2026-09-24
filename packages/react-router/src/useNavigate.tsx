'use client'

import * as React from 'react'
import { useLayoutEffect } from './utils'
import { useRouter } from './useRouter'
import { usePresentedLocation } from './routerStateContext'
import type {
  AnyRouter,
  FromPathOption,
  NavigateOptions,
  RegisteredRouter,
  UseNavigateResult,
} from '@tanstack/router-core'

/**
 * Imperative navigation hook.
 *
 * Returns a stable `navigate(options)` function to change the current location
 * programmatically. Prefer the `Link` component for user-initiated navigation,
 * and use this hook from effects, callbacks, or handlers where imperative
 * navigation is required.
 *
 * Options:
 * - `from`: Optional route base used to resolve relative `to` paths.
 *
 * @returns A function that accepts `NavigateOptions`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useNavigateHook
 */
export function useNavigate<
  TRouter extends AnyRouter = RegisteredRouter,
  TDefaultFrom extends string = string,
>(_defaultOpts?: {
  from?: FromPathOption<TRouter, TDefaultFrom>
}): UseNavigateResult<TDefaultFrom> {
  const router = useRouter()
  // Resolve against the route the caller is looking at, not the one the router
  // is preparing. With concurrent render frames a handler still on the old
  // route would otherwise inherit the pending navigation's search or params —
  // the same reason `Link` resolves its click from the location it rendered
  // against. Read at call time; an explicit `_fromLocation` still wins.
  const presentedLocation = usePresentedLocation(router)

  return React.useCallback(
    (options: NavigateOptions) => {
      return router.navigate({
        _fromLocation: presentedLocation?.(),
        ...options,
        from: options.from ?? _defaultOpts?.from,
      } as NavigateOptions)
    },
    [_defaultOpts?.from, presentedLocation, router],
  ) as UseNavigateResult<TDefaultFrom>
}

/**
 * Component that triggers a navigation when rendered. Navigation executes
 * in an effect after mount/update.
 *
 * Props are the same as `NavigateOptions` used by `navigate()`.
 *
 * @returns null
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/navigateComponent
 */
export function Navigate<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(props: NavigateOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>): null {
  const router = useRouter()
  const navigate = useNavigate()

  const previousPropsRef = React.useRef<NavigateOptions<
    TRouter,
    TFrom,
    TTo,
    TMaskFrom,
    TMaskTo
  > | null>(null)
  useLayoutEffect(() => {
    if (previousPropsRef.current !== props) {
      navigate(props)
      previousPropsRef.current = props
    }
  }, [router, props, navigate])
  return null
}
