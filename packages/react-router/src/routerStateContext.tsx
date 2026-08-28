'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useLayoutEffect } from './utils'
import { useHydrated } from './ClientOnly'
import type { AnyRouter, RouterState } from '@tanstack/router-core'

export type RouterRenderFrame = RouterState<any>

type FrameSubscriber = (frame: RouterRenderFrame) => void

type RouterStateOwner = {
  router: AnyRouter
  /** The frame React has committed and painted. */
  frame: RouterRenderFrame
  /** The frame the tree should render now: a staged successor, else committed. */
  getRenderFrame: () => RouterRenderFrame
  /**
   * Register for frame publications. Subscribers are notified from inside the
   * Router's `startTransition`, so their updates keep the transition lane.
   */
  subscribe: (subscriber: FrameSubscriber) => () => void
  begin: () => void
  stage: (frame: RouterRenderFrame) => RouterRenderFrame
  cancel: () => void
  commit: (frame: RouterRenderFrame) => boolean
  /** Adopt head state as the committed frame when no navigation is staged. */
  publish: () => void
}

const defaultCompare = (a: unknown, b: unknown) => a === b

/**
 * Stable for the lifetime of the Router. Selector hooks read this and
 * subscribe, so publishing a frame does not invalidate every consumer.
 */
const routerStateOwnerContext = React.createContext<
  RouterStateOwner | undefined
>(undefined)

/**
 * Carries the exact frame a subtree is rendering. Only route presentation
 * reads it, because those components re-render per navigation regardless.
 */
const routerFrameContext = React.createContext<RouterRenderFrame | undefined>(
  undefined,
)

export function RouterStateProvider({
  router,
  children,
}: {
  router: AnyRouter
  children: React.ReactNode
}) {
  const [committed, setCommitted] = React.useState<RouterRenderFrame>(() =>
    router.stores.__store.get(),
  )

  const ownerRef = React.useRef<RouterStateOwner | undefined>(undefined)
  if (!ownerRef.current) {
    const subscribers = new Set<FrameSubscriber>()
    let staging = false
    let pending: RouterRenderFrame | undefined

    const notify = (frame: RouterRenderFrame) => {
      // Copy first: a subscriber may unsubscribe while we iterate.
      for (const subscriber of Array.from(subscribers)) {
        subscriber(frame)
      }
    }

    const owner: RouterStateOwner = {
      router,
      frame: committed,
      getRenderFrame: () => pending ?? owner.frame,
      subscribe: (subscriber) => {
        subscribers.add(subscriber)
        return () => {
          subscribers.delete(subscriber)
        }
      },
      begin: () => {
        staging = true
      },
      stage: (nextFrame) => {
        staging = false
        pending = nextFrame
        notify(nextFrame)
        return nextFrame
      },
      cancel: () => {
        staging = false
        pending = undefined
        owner.publish()
      },
      commit: (nextFrame) => {
        if (pending?.frameId !== nextFrame.frameId) {
          return false
        }
        pending = undefined
        owner.frame = nextFrame
        setCommitted(nextFrame)
        return true
      },
      // Publication outside a Router transition: adopt the head state as the
      // committed frame, unless a navigation is being staged or is pending.
      publish: () => {
        if (staging || pending) {
          return
        }
        const nextFrame = router.stores.__store.get()
        if (nextFrame.status === 'pending') {
          return
        }
        if (nextFrame.frameId === owner.frame.frameId) {
          return
        }
        owner.frame = nextFrame
        setCommitted(nextFrame)
        notify(nextFrame)
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
      <routerFrameContext.Provider value={committed}>
        {children}
      </routerFrameContext.Provider>
    </routerStateOwnerContext.Provider>
  )
}

/** Override the frame for a subtree that is rendering a staged successor. */
export function RouterStateFrame({
  frame,
  children,
}: {
  frame: RouterRenderFrame
  children: React.ReactNode
}) {
  return (
    <routerFrameContext.Provider value={frame}>
      {children}
    </routerFrameContext.Provider>
  )
}

export function useRouterStateOwner() {
  return React.useContext(routerStateOwnerContext)
}

/** The committed frame, for route presentation that must track every frame. */
export function useRouterFrame() {
  return React.useContext(routerFrameContext)
}

export function useRouterStateSelector<TSelected>(
  router: AnyRouter,
  selector: (state: RouterState<any>) => TSelected,
  compare: (a: TSelected, b: TSelected) => boolean = defaultCompare,
): TSelected {
  const owner = React.useContext(routerStateOwnerContext)

  if (!owner || owner.router !== router) {
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

  selection.current = selector(owner.getRenderFrame())

  // eslint-disable-next-line react-hooks/rules-of-hooks
  React.useEffect(() => {
    // Re-render only when this subscriber's own selection changed, which is
    // what keeps selector-level render counts identical to the store path.
    return owner.subscribe((frame) => {
      const next = latest.current.selector(frame)
      if (!latest.current.compare(selection.current, next)) {
        forceRender()
      }
    })
  }, [owner])

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
