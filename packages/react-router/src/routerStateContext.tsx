'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useLayoutEffect } from './utils'
import { useHydrated } from './ClientOnly'
import type { AnyRouter, RouterState } from '@tanstack/router-core'

export type RouterRenderFrame = RouterState<any>

type FrameSubscriber = (frame: RouterRenderFrame) => void

/**
 * A position in the tree, with the frame that position should render.
 *
 * Identity is stable for the router's lifetime, so putting a scope in Context
 * never invalidates its consumers; they subscribe for updates instead. Which
 * scope a consumer reads is decided by where it sits:
 *
 * - outside the route tree it reads the committed frame, and only advances
 *   when a navigation commits;
 * - inside the route tree it reads the frame that subtree is rendering, which
 *   is a staged successor while a navigation is in flight.
 *
 * That is what keeps a reader mounted by an unrelated urgent update on the
 * route the user can actually see.
 */
type RouterStateScope = {
  router: AnyRouter
  frame: RouterRenderFrame
  subscribe: (subscriber: FrameSubscriber) => () => void
  notify: () => void
}

type RouterStateOwner = {
  router: AnyRouter
  /** The committed scope, for readers outside the route tree. */
  root: RouterStateScope
  /** The presentation scope, for the route subtree. */
  route: RouterStateScope
  /** The committed frame. */
  frame: RouterRenderFrame
  begin: () => void
  stage: (frame: RouterRenderFrame) => RouterRenderFrame
  cancel: () => void
  commit: (frame: RouterRenderFrame) => boolean
  publish: () => void
}

const defaultCompare = (a: unknown, b: unknown) => a === b

function createScope(
  router: AnyRouter,
  frame: RouterRenderFrame,
): RouterStateScope {
  const subscribers = new Set<FrameSubscriber>()
  const scope: RouterStateScope = {
    router,
    frame,
    subscribe: (subscriber) => {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    notify: () => {
      // Copy first: a subscriber may unsubscribe while we iterate.
      for (const subscriber of Array.from(subscribers)) {
        subscriber(scope.frame)
      }
    },
  }
  return scope
}

const routerStateScopeContext = React.createContext<
  RouterStateScope | undefined
>(undefined)

const routerStateOwnerContext = React.createContext<
  RouterStateOwner | undefined
>(undefined)

export function RouterStateProvider({
  router,
  children,
}: {
  router: AnyRouter
  children: React.ReactNode
}) {
  const ownerRef = React.useRef<RouterStateOwner | undefined>(undefined)
  if (!ownerRef.current) {
    const initial = router.stores.__store.get()
    const root = createScope(router, initial)
    const route = createScope(router, initial)
    let staging = false
    let pending: RouterRenderFrame | undefined

    const owner: RouterStateOwner = {
      router,
      root,
      route,
      get frame() {
        return root.frame
      },
      begin: () => {
        staging = true
      },
      stage: (nextFrame) => {
        staging = false
        pending = nextFrame
        // Only the route subtree presents a staged frame. Readers outside it
        // stay on the committed one until this navigation commits.
        route.frame = nextFrame
        route.notify()
        return nextFrame
      },
      cancel: () => {
        staging = false
        pending = undefined
        route.frame = root.frame
        route.notify()
        owner.publish()
      },
      commit: (nextFrame) => {
        if (pending?.frameId !== nextFrame.frameId) {
          return false
        }
        pending = undefined
        root.frame = nextFrame
        root.notify()
        return true
      },
      publish: () => {
        if (staging || pending) {
          return
        }
        const nextFrame = router.stores.__store.get()
        if (nextFrame.status === 'pending') {
          return
        }
        if (nextFrame.frameId === root.frame.frameId) {
          return
        }
        root.frame = nextFrame
        route.frame = nextFrame
        root.notify()
        route.notify()
      },
    }
    ownerRef.current = owner
  }

  const owner = ownerRef.current

  useLayoutEffect(() => {
    const subscription = router.stores.__store.subscribe(() => owner.publish())
    owner.publish()
    return () => subscription.unsubscribe()
  }, [owner, router])

  return (
    <routerStateOwnerContext.Provider value={owner}>
      <routerStateScopeContext.Provider value={owner.root}>
        {children}
      </routerStateScopeContext.Provider>
    </routerStateOwnerContext.Provider>
  )
}

/** Present the route subtree from the presentation scope. */
export function RouterStateFrame({ children }: { children: React.ReactNode }) {
  const owner = React.useContext(routerStateOwnerContext)
  return (
    <routerStateScopeContext.Provider value={owner?.route}>
      {children}
    </routerStateScopeContext.Provider>
  )
}

export function useRouterStateOwner() {
  return React.useContext(routerStateOwnerContext)
}

export function useRouterStateSelector<TSelected>(
  router: AnyRouter,
  selector: (state: RouterState<any>) => TSelected,
  compare: (a: TSelected, b: TSelected) => boolean = defaultCompare,
): TSelected {
  const scope = React.useContext(routerStateScopeContext)

  if (!scope || scope.router !== router) {
    if (isServer ?? router.isServer) {
      return selector(router.stores.__store.get())
    }
    // The frame option is fixed when the router is created, so this branch
    // cannot change hook order during the lifetime of a mounted router.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStore(router.stores.__store, selector, compare)
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const selection = React.useRef<TSelected>(undefined as TSelected)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const latest = React.useRef({ selector, compare })
  latest.current = { selector, compare }

  selection.current = selector(scope.frame)

  // eslint-disable-next-line react-hooks/rules-of-hooks
  React.useEffect(() => {
    // Re-render only when this subscriber's own selection changed, which is
    // what keeps selector-level render counts identical to the store path.
    return scope.subscribe((frame) => {
      const next = latest.current.selector(frame)
      if (!latest.current.compare(selection.current, next)) {
        forceRender()
      }
    })
  }, [scope])

  return selection.current
}

/**
 * Whether this render should consolidate route suspension at the frame root.
 *
 * Only the frame path asks, so `useHydrated` is never subscribed to on the
 * default path. Within the frame branch the hook is unconditional, and the
 * branch itself depends only on the option, which is fixed when the router is
 * created.
 */
export function useFrameRootBoundary(
  router: AnyRouter,
  isServerRender: boolean,
): boolean {
  if (!router.options.experimental_concurrentRenderFrames) {
    return false
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const hydrated = useHydrated()
  const isHydrating = Boolean(router.ssr) && !hydrated
  return !isServerRender && !isHydrating
}
