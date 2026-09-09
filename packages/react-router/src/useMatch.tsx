'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { invariant, replaceEqualDeep } from '@tanstack/router-core'
import { isServer } from '@tanstack/router-core/isServer'
import { dummyMatchContext, matchContext } from './matchContext'
import { useRouter } from './useRouter'
import {
  useFrameMode,
  useRouterStateSelector,
} from './routerStateContext'
import type {
  StructuralSharingOption,
  ValidateSelected,
} from './structuralSharing'
import type {
  AnyRouter,
  MakeRouteMatch,
  MakeRouteMatchUnion,
  RegisteredRouter,
  RouterState,
  StrictOrFrom,
  ThrowConstraint,
  ThrowOrOptional,
} from '@tanstack/router-core'

const dummyMatch = {}

/**
 * A selector whose cached previous result can be saved and put back.
 *
 * Structural sharing keeps a consumer's selection referentially stable by
 * caching the last result and returning it again whenever the next one is
 * deep-equal. The render-frame path also runs selectors *outside* render, to
 * decide whether a consumer's selection changed under a publication it has
 * been offered — and a cache write from there describes a render that may
 * never commit. So that path saves the cache, runs the selector, and puts the
 * cache back; a consumer that accepts the offer re-renders and writes it for
 * real. See `useRouterStateSelector`.
 */
export type CacheableSelector<TSlice, TSelected> = ((
  slice: TSlice,
) => TSelected) & {
  snapshotCache?: () => unknown
  restoreCache?: (cached: unknown) => void
}

/**
 * Carry a selector's cache handles onto a closure wrapping it, so a caller
 * that selects from a frame through a structural-sharing selector stays
 * probe-safe.
 */
export function withSelectorCache<TOuter, TInner, TSelected>(
  wrapper: (slice: TOuter) => TSelected,
  inner: CacheableSelector<TInner, any>,
): CacheableSelector<TOuter, TSelected> {
  const cacheable: CacheableSelector<TOuter, TSelected> = wrapper
  cacheable.snapshotCache = inner.snapshotCache
  cacheable.restoreCache = inner.restoreCache
  return cacheable
}

export function useStructuralSharing<
  TRouter extends AnyRouter,
  TSelected,
  TStructuralSharing extends boolean,
  TStoreSlice,
  TSelectSlice = TStoreSlice,
>(
  opts:
    | {
        select?: (
          slice: TSelectSlice,
        ) => ValidateSelected<TRouter, TSelected, TStructuralSharing>
        structuralSharing?: boolean
      }
    | undefined,
  router: TRouter,
): CacheableSelector<
  TStoreSlice,
  ValidateSelected<TRouter, TSelected, TStructuralSharing>
> {
  const previousResult =
    // @ts-expect-error -- init to undefined, but without writing `undefined` to shave bytes
    React.useRef<ValidateSelected<TRouter, TSelected, TStructuralSharing>>()

  const select: CacheableSelector<
    TStoreSlice,
    ValidateSelected<TRouter, TSelected, TStructuralSharing>
  > = (slice) => {
    const selected = opts?.select
      ? opts.select(slice as unknown as TSelectSlice)
      : (slice as ValidateSelected<TRouter, TSelected, TStructuralSharing>)

    if (opts?.structuralSharing ?? router.options.defaultStructuralSharing) {
      return (previousResult.current = replaceEqualDeep(
        previousResult.current,
        selected,
      ))
    }

    return selected
  }
  select.snapshotCache = () => previousResult.current
  select.restoreCache = (cached: unknown) => {
    previousResult.current =
      cached as ValidateSelected<TRouter, TSelected, TStructuralSharing>
  }
  return select
}

export interface UseMatchBaseOptions<
  TRouter extends AnyRouter,
  TFrom,
  TStrict extends boolean,
  TThrow extends boolean,
  TSelected,
  TStructuralSharing extends boolean,
> {
  select?: (
    match: MakeRouteMatch<TRouter['routeTree'], TFrom, TStrict>,
  ) => ValidateSelected<TRouter, TSelected, TStructuralSharing>
  shouldThrow?: TThrow
}

export type UseMatchRoute<out TFrom> = <
  TRouter extends AnyRouter = RegisteredRouter,
  TSelected = unknown,
  TStructuralSharing extends boolean = boolean,
  TThrow extends boolean = true,
>(
  opts?: UseMatchBaseOptions<
    TRouter,
    TFrom,
    true,
    TThrow,
    TSelected,
    TStructuralSharing
  > &
    StructuralSharingOption<TRouter, TSelected, TStructuralSharing>,
) => ThrowOrOptional<UseMatchResult<TRouter, TFrom, true, TSelected>, TThrow>

export type UseMatchOptions<
  TRouter extends AnyRouter,
  TFrom extends string | undefined,
  TStrict extends boolean,
  TThrow extends boolean,
  TSelected,
  TStructuralSharing extends boolean,
> = StrictOrFrom<TRouter, TFrom, TStrict> &
  UseMatchBaseOptions<
    TRouter,
    TFrom,
    TStrict,
    TThrow,
    TSelected,
    TStructuralSharing
  > &
  StructuralSharingOption<TRouter, TSelected, TStructuralSharing>

export type UseMatchResult<
  TRouter extends AnyRouter,
  TFrom,
  TStrict extends boolean,
  TSelected,
> = unknown extends TSelected
  ? TStrict extends true
    ? MakeRouteMatch<TRouter['routeTree'], TFrom, TStrict>
    : MakeRouteMatchUnion<TRouter>
  : TSelected

/**
 * Read and select the nearest or targeted route match.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchHook
 */
export function useMatch<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string | undefined = undefined,
  TStrict extends boolean = true,
  TThrow extends boolean = true,
  TSelected = unknown,
  TStructuralSharing extends boolean = boolean,
>(
  opts: UseMatchOptions<
    TRouter,
    TFrom,
    TStrict,
    ThrowConstraint<TStrict, TThrow>,
    TSelected,
    TStructuralSharing
  >,
): ThrowOrOptional<UseMatchResult<TRouter, TFrom, TStrict, TSelected>, TThrow> {
  const router = useRouter<TRouter>()
  const nearestRouteId = React.useContext(
    opts.from ? dummyMatchContext : matchContext,
  )

  const routeId = opts.from ?? nearestRouteId
  const matchStore = router.stores.getMatchStore(routeId!)

  if (!useFrameMode(router)) {
    if (isServer ?? router.isServer) {
      const match = matchStore.get()
      if (!match) {
        if (opts.shouldThrow ?? true) {
          if (process.env.NODE_ENV !== 'production') {
            throw new Error(
              `Invariant failed: Could not find ${opts.from ? `an active match from "${opts.from}"` : 'a nearest match!'}`,
            )
          }

          invariant()
        }

        return undefined as any
      }

      return (opts.select ? opts.select(match as any) : match) as any
    }

    // eslint-disable-next-line react-hooks/rules-of-hooks -- frozen at mount
    const selector = useStructuralSharing(opts, router)
    // eslint-disable-next-line react-hooks/rules-of-hooks -- frozen at mount
    const matchSelection = useStore(matchStore, (match) =>
      match ? selector(match as any) : dummyMatch,
    )

    if (matchSelection !== dummyMatch) {
      return matchSelection as any
    }
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- frozen at mount
    const selector = useStructuralSharing(opts, router)
    // eslint-disable-next-line react-hooks/rules-of-hooks -- frozen at mount
    const matchSelection = useRouterStateSelector(
      router,
      withSelectorCache((state: RouterState<any>) => {
        const match = state.matches.find(
          (candidate) => candidate.routeId === routeId,
        )
        return match ? selector(match as any) : dummyMatch
      }, selector),
    )

    if (matchSelection !== dummyMatch) {
      return matchSelection as any
    }
  }

  if (opts.shouldThrow ?? true) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `Invariant failed: Could not find ${opts.from ? `an active match from "${opts.from}"` : 'a nearest match!'}`,
      )
    }

    invariant()
  }

  return undefined as any
}
