'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { rootRouteId } from '@tanstack/router-core'
import { isServer } from '@tanstack/router-core/isServer'
import { CatchBoundary } from './CatchBoundary'
import { useRouter } from './useRouter'
import { useStructuralSharing } from './useMatch'
import { useLayoutEffect } from './utils'
import { Transitioner, settleOwner } from './Transitioner'
import { matchContext } from './matchContext'
import { Match, renderPending } from './Match'
import { SafeFragment } from './SafeFragment'
import {
  RouterStateFrame,
  useFrameRootBoundary,
  useRouterFrame,
  useRouterStateOwner,
  useRouterStateSelector,
} from './routerStateContext'
import type { RouterRenderFrame } from './routerStateContext'
import type {
  StructuralSharingOption,
  ValidateSelected,
} from './structuralSharing'
import type {
  AnyRoute,
  AnyRouteMatch,
  AnyRouter,
  DeepPartial,
  Expand,
  MakeOptionalPathParams,
  MakeOptionalSearchParams,
  MakeRouteMatchUnion,
  MaskOptions,
  MatchRouteOptions,
  RegisteredRouter,
  ResolveRoute,
  ToSubOptionsProps,
} from '@tanstack/router-core'

declare module '@tanstack/router-core' {
  export interface RouteMatchExtensions {
    meta?: Array<React.JSX.IntrinsicElements['meta'] | undefined>
    links?: Array<React.JSX.IntrinsicElements['link'] | undefined>
    scripts?: Array<React.JSX.IntrinsicElements['script'] | undefined>
    styles?: Array<React.JSX.IntrinsicElements['style'] | undefined>
    headScripts?: Array<React.JSX.IntrinsicElements['script'] | undefined>
  }
}

/**
 * Internal component that renders the router's active match tree with
 * suspense, error, and not-found boundaries. Rendered by `RouterProvider`.
 */
export function Matches() {
  const router = useRouter()
  const committedFrame = useRouterFrame()
  const [renderFrame, setRenderFrame] = React.useState<RouterRenderFrame>()
  const activeFrame = renderFrame ?? committedFrame
  const rootRoute: AnyRoute = router.routesById[rootRouteId]

  const pendingElement = renderPending(router, rootRoute)

  const _isServer = isServer ?? router.isServer
  // SSR and hydration keep upstream's route-level boundaries for streaming
  // and an identical hydration tree. Afterwards, the frame path consolidates
  // suspension at this root so one complete frame is acknowledged atomically.
  const frameRootBoundary = useFrameRootBoundary(router, _isServer)
  const ResolvedSuspense =
    _isServer || (router.ssr && !frameRootBoundary)
      ? SafeFragment
      : React.Suspense

  const inner = (
    <>
      {!(isServer ?? router.isServer) && (
        <Transitioner
          // The initial load publishes matches before MatchesInner's store
          // subscription is active. Storing the router here forces Matches to render
          // that first publication before paint. Later publications store the same
          // router object, so React skips the update.
          // eslint-disable-next-line react-hooks/rules-of-hooks -- server only, condition is static
          t={React.useState<AnyRouter>()[1]}
          setRenderFrame={setRenderFrame}
        />
      )}
      <ResolvedSuspense fallback={pendingElement}>
        {activeFrame ? (
          <RouterStateFrame frame={activeFrame}>
            <MatchesInner
              activeFrame={activeFrame}
              renderFrame={renderFrame}
              setRenderFrame={setRenderFrame}
            />
          </RouterStateFrame>
        ) : (
          <MatchesInner setRenderFrame={setRenderFrame} />
        )}
      </ResolvedSuspense>
    </>
  )

  return router.options.InnerWrap ? (
    <router.options.InnerWrap>{inner}</router.options.InnerWrap>
  ) : (
    inner
  )
}

function MatchesInner({
  activeFrame,
  renderFrame,
  setRenderFrame,
}: {
  activeFrame?: RouterRenderFrame
  renderFrame?: RouterRenderFrame
  setRenderFrame: React.Dispatch<
    React.SetStateAction<RouterRenderFrame | undefined>
  >
}) {
  const router = useRouter()
  const routerStateOwner = useRouterStateOwner()
  const acknowledgement = router._rendered!
  let matches: Array<AnyRouteMatch>
  if (router.options.experimental_concurrentRenderFrames) {
    // The option is fixed for the mounted router, so this branch cannot change
    // hook order during the component's lifetime.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    matches = useRouterStateSelector(router, (state) => state.matches)
  } else if (isServer ?? router.isServer) {
    matches = router.stores.matches.get()
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    matches = useStore(router.stores.matches, (value) =>
      Array.isArray(acknowledgement[0 /* offered */])
        ? acknowledgement[0 /* offered */]
        : value,
    )
  }
  const match = matches[0]
  const routeId = match?.routeId

  useLayoutEffect(() => {
    const acknowledged = router.options.experimental_concurrentRenderFrames
      ? acknowledgement[0 /* offered */] === activeFrame?.frameId
      : acknowledgement[0 /* offered */] === matches
    if (acknowledged) {
      if (renderFrame && routerStateOwner?.commit(renderFrame)) {
        setRenderFrame(undefined)
      }
      settleOwner(acknowledgement, true)
    }
  }, [
    acknowledgement,
    activeFrame,
    matches,
    renderFrame,
    router.options.experimental_concurrentRenderFrames,
    routerStateOwner,
    setRenderFrame,
  ])

  const matchComponent = routeId ? <Match routeId={routeId} /> : null

  return (
    <matchContext.Provider value={routeId}>
      {router.options.disableGlobalCatchBoundary ? (
        matchComponent
      ) : (
        <CatchBoundary
          getResetKey={() => match}
          onCatch={
            process.env.NODE_ENV !== 'production'
              ? (error) => {
                  console.warn(
                    `Warning: The following error wasn't caught by any route! At the very least, consider setting an 'errorComponent' in your RootRoute!`,
                  )
                  console.warn(`Warning: ${error.message || error.toString()}`)
                }
              : undefined
          }
        >
          {matchComponent}
        </CatchBoundary>
      )}
    </matchContext.Provider>
  )
}

export type UseMatchRouteOptions<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = undefined,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '',
> = ToSubOptionsProps<TRouter, TFrom, TTo> &
  DeepPartial<MakeOptionalSearchParams<TRouter, TFrom, TTo>> &
  DeepPartial<MakeOptionalPathParams<TRouter, TFrom, TTo>> &
  MaskOptions<TRouter, TMaskFrom, TMaskTo> &
  MatchRouteOptions

/**
 * Create a matcher function for testing locations against route definitions.
 *
 * The returned function accepts standard navigation options (`to`, `params`,
 * `search`, etc.) and returns either `false` (no match) or the matched params
 * object when the route matches the current or pending location.
 *
 * Useful for conditional rendering and active UI states because it subscribes
 * the component to the router state used for matching. The returned function's
 * identity changes when that state changes. For imperative checks in event
 * handlers, get the router with `useRouter` and call `router.matchRoute(...)`
 * to avoid that subscription.
 *
 * @returns A `matchRoute(options)` function that returns `false` or params.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchRouteHook
 */
export function useMatchRoute<TRouter extends AnyRouter = RegisteredRouter>(): <
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  opts: UseMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>,
) => false | Expand<ResolveRoute<TRouter, TFrom, TTo>['types']['allParams']> {
  const router = useRouter()
  if (isServer ?? router.isServer) {
    return (opts) => {
      const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts

      return router.matchRoute(rest as any, {
        pending,
        caseSensitive,
        fuzzy,
        includeSearch,
      })
    }
  }

  if (router.options.experimental_concurrentRenderFrames) {
    // The option is fixed for the mounted router, so this branch cannot change
    // hook order during the component's lifetime.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const state = useRouterStateSelector(router, (frameState) => frameState)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return React.useCallback(
      (opts) => {
        const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts

        // Match against the presented frame so a pending imperative location
        // cannot leak into the committed render.
        return router.matchRoute(
          rest as any,
          {
            pending,
            caseSensitive,
            fuzzy,
            includeSearch,
            _state: state,
          } as any,
        )
      },
      [router, state],
    )
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return React.useCallback(
    (opts) => {
      const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts

      return router.matchRoute(rest as any, {
        pending,
        caseSensitive,
        fuzzy,
        includeSearch,
      })
    },
    [
      router,
      // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
      useStore(router.stores.location, (location) => location.href),
      // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
      useStore(router.stores.resolvedLocation, (location) => location?.href),
      // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
      useStore(router.stores.status, (status) => status),
    ],
  )
}

export type MakeMatchRouteOptions<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = undefined,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '',
> = UseMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & {
  // If a function is passed as a child, it will be given the `isActive` boolean to aid in further styling on the element it returns
  children?:
    | ((
        params?: Expand<
          ResolveRoute<TRouter, TFrom, TTo>['types']['allParams']
        >,
      ) => React.ReactNode)
    | React.ReactNode
}

/**
 * Component that conditionally renders its children based on whether a route
 * matches the provided `from`/`to` options. If `children` is a function, it
 * receives the matched params object.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/matchRouteComponent
 */
export function MatchRoute<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(props: MakeMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>): any {
  const matchRoute = useMatchRoute()
  const params = matchRoute(props as any) as boolean

  if (typeof props.children === 'function') {
    return (props.children as any)(params)
  }

  return params ? props.children : null
}

export interface UseMatchesBaseOptions<
  TRouter extends AnyRouter,
  TSelected,
  TStructuralSharing,
> {
  select?: (
    matches: Array<MakeRouteMatchUnion<TRouter>>,
  ) => ValidateSelected<TRouter, TSelected, TStructuralSharing>
}

export type UseMatchesResult<
  TRouter extends AnyRouter,
  TSelected,
> = unknown extends TSelected ? Array<MakeRouteMatchUnion<TRouter>> : TSelected

export function useMatches<
  TRouter extends AnyRouter = RegisteredRouter,
  TSelected = unknown,
  TStructuralSharing extends boolean = boolean,
>(
  opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> &
    StructuralSharingOption<TRouter, TSelected, TStructuralSharing>,
): UseMatchesResult<TRouter, TSelected> {
  const router = useRouter<TRouter>()

  if (router.options.experimental_concurrentRenderFrames) {
    // The option is fixed for the mounted router, so this branch cannot change
    // hook order during the component's lifetime.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const selectMatches = useStructuralSharing(opts, router)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRouterStateSelector(router, (state) =>
      selectMatches(state.matches),
    ) as UseMatchesResult<TRouter, TSelected>
  }

  if (isServer ?? router.isServer) {
    const matches = router.stores.matches.get() as Array<
      MakeRouteMatchUnion<TRouter>
    >
    return (opts?.select ? opts.select(matches) : matches) as UseMatchesResult<
      TRouter,
      TSelected
    >
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
  return useStore(
    router.stores.matches,
    // eslint-disable-next-line react-hooks/rules-of-hooks -- condition is static
    useStructuralSharing(opts, router),
  ) as UseMatchesResult<TRouter, TSelected>
}

/**
 * Read the presented route matches above the current match, or select a
 * derived value from them.
 */
export function useParentMatches<
  TRouter extends AnyRouter = RegisteredRouter,
  TSelected = unknown,
  TStructuralSharing extends boolean = boolean,
>(
  opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> &
    StructuralSharingOption<TRouter, TSelected, TStructuralSharing>,
): UseMatchesResult<TRouter, TSelected> {
  const contextRouteId = React.useContext(matchContext)

  return useMatches({
    select: (matches: Array<MakeRouteMatchUnion<TRouter>>) => {
      matches = matches.slice(
        0,
        matches.findIndex((d) => d.routeId === contextRouteId),
      )
      return opts?.select ? opts.select(matches) : matches
    },
    structuralSharing: opts?.structuralSharing,
  } as any)
}

/**
 * Read the presented route matches below the current match, or select a
 * derived value from them.
 */
export function useChildMatches<
  TRouter extends AnyRouter = RegisteredRouter,
  TSelected = unknown,
  TStructuralSharing extends boolean = boolean,
>(
  opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> &
    StructuralSharingOption<TRouter, TSelected, TStructuralSharing>,
): UseMatchesResult<TRouter, TSelected> {
  const contextRouteId = React.useContext(matchContext)

  return useMatches({
    select: (matches: Array<MakeRouteMatchUnion<TRouter>>) => {
      matches = matches.slice(
        matches.findIndex((d) => d.routeId === contextRouteId) + 1,
      )
      return opts?.select ? opts.select(matches) : matches
    },
    structuralSharing: opts?.structuralSharing,
  } as any)
}
