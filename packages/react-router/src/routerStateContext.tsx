'use client'

import * as React from 'react'
import { useStore } from '@tanstack/react-store'
import { isServer } from '@tanstack/router-core/isServer'
import { useLayoutEffect } from './utils'
import { useHydrated } from './ClientOnly'
import type { AnyRouter, RouterState } from '@tanstack/router-core'

export type RouterRenderFrame = RouterState<any>

/**
 * Notified either with a staged publication being *offered* — which only ever
 * happens from inside the Router's `startTransition` — or with nothing, meaning
 * "re-read whatever you are already presenting". A subscriber may move onto a
 * staged publication only in the first case, so no notification sent outside a
 * transition can move a consumer off the route it is showing.
 */
type FrameSubscriber = (offered: RouterRenderFrame | undefined) => void

/**
 * A position in the tree, and the publications that position can present.
 *
 * Identity is stable for the router's lifetime, so putting a scope in Context
 * never invalidates its consumers; they subscribe for updates instead. Which
 * scope a consumer reads is decided by where it sits:
 *
 * - outside the route tree it reads the committed publication, and only
 *   advances when a navigation commits;
 * - inside the route tree it can also present a staged successor, while a
 *   navigation is in flight.
 *
 * A scope holds both publications in separate slots rather than one mutable
 * field. A consumer records, in React state, *which* publication its own
 * render is presenting, and React versions that state per tree. So a
 * work-in-progress render that has been offered the staged publication cannot
 * drag it into the tree the user is still looking at.
 */
type RouterStateScope = {
  router: AnyRouter
  /** The publication this position has committed. */
  committed: RouterRenderFrame
  /** A publication offered to the render presenting it, not yet committed. */
  staged: RouterRenderFrame | undefined
  subscribe: (subscriber: FrameSubscriber) => () => void
  notify: (offered?: RouterRenderFrame) => void
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

/** The publication a fresh reader at this position should start from. */
function offeredFrame(scope: RouterStateScope): RouterRenderFrame {
  return scope.staged ?? scope.committed
}

/**
 * The publication a render presenting `frameId` should read.
 *
 * A render that was offered the staged publication keeps reading it until it
 * commits or is discarded. Every other render — including one the staged
 * publication was never offered to, because its own selection did not change —
 * reads the committed publication.
 */
function resolveFrame(
  scope: RouterStateScope,
  frameId: number,
): RouterRenderFrame {
  const staged = scope.staged
  return staged && staged.frameId === frameId ? staged : scope.committed
}

/** Overlay navigation progress onto a publication without changing its content. */
function withProgress(
  frame: RouterRenderFrame,
  head: RouterRenderFrame,
): RouterRenderFrame {
  if (frame.status === head.status && frame.isLoading === head.isLoading) {
    return frame
  }
  return { ...frame, status: head.status, isLoading: head.isLoading }
}

function createScope(
  router: AnyRouter,
  frame: RouterRenderFrame,
): RouterStateScope {
  const subscribers = new Set<FrameSubscriber>()
  const scope: RouterStateScope = {
    router,
    committed: frame,
    staged: undefined,
    subscribe: (subscriber) => {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    notify: (offered) => {
      // Copy first: a subscriber may unsubscribe while we iterate.
      for (const subscriber of Array.from(subscribers)) {
        subscriber(offered)
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

    // Navigation progress is not route content. Both scopes stay on the route
    // they are presenting, but their status tracks the head, so progress UI —
    // a global loading bar outside the route tree, or a spinner rendered by the
    // route the user is leaving — sees a navigation start and finish. Location
    // and matches are untouched, so this cannot surface a route the user
    // cannot see.
    const syncProgress = (head: RouterRenderFrame) => {
      let changed = false
      for (const scope of [root, route]) {
        const nextCommitted = withProgress(scope.committed, head)
        if (nextCommitted !== scope.committed) {
          scope.committed = nextCommitted
          changed = true
        }
        if (scope.staged) {
          const nextStaged = withProgress(scope.staged, head)
          if (nextStaged !== scope.staged) {
            scope.staged = nextStaged
            changed = true
          }
        }
      }
      if (changed) {
        // A refresh, never an offer. This runs from the store's subscription,
        // outside any transition: offering the staged publication here would
        // let an urgent update move the visible tree onto a route that has not
        // committed. Consumers re-read the slot they are already presenting,
        // which is where the overlaid progress now is.
        root.notify()
        route.notify()
      }
    }

    const owner: RouterStateOwner = {
      router,
      root,
      route,
      get frame() {
        return root.committed
      },
      begin: () => {
        staging = true
      },
      stage: (nextFrame) => {
        staging = false
        pending = nextFrame
        // Only the route subtree is offered a staged publication, and only the
        // render that accepts it presents it. Readers outside that subtree, and
        // readers whose own selection did not change, stay on the committed
        // publication until this navigation commits.
        route.staged = nextFrame
        // The one and only offer, and it is inside `startTransition`.
        route.notify(nextFrame)
        return nextFrame
      },
      cancel: () => {
        staging = false
        pending = undefined
        route.staged = undefined
        route.notify()
        owner.publish()
      },
      commit: (nextFrame) => {
        if (pending?.frameId !== nextFrame.frameId) {
          return false
        }
        pending = undefined
        // The staged publication is now what everyone has committed, so the
        // staged slot empties and both scopes resolve to it.
        root.committed = nextFrame
        route.committed = nextFrame
        route.staged = undefined
        root.notify()
        route.notify()
        return true
      },
      publish: () => {
        const head = router.stores.__store.get()
        if (staging || pending) {
          syncProgress(head)
          return
        }
        const nextFrame = head
        if (nextFrame.status === 'pending') {
          syncProgress(head)
          return
        }
        if (nextFrame.frameId === root.committed.frameId) {
          return
        }
        root.committed = nextFrame
        route.committed = nextFrame
        route.staged = undefined
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

  // Which publication this consumer is presenting. It lives in React state, so
  // React versions it per tree: a work-in-progress render can accept the staged
  // publication without the still-visible tree following it there. `revision`
  // makes every accepted update a distinct state value, so a progress-only
  // change — same frame, new status — still re-renders.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [presenting, setPresenting] = React.useState(() => ({
    frameId: offeredFrame(scope).frameId,
    revision: 0,
  }))
  // The selection for the render currently executing. A render can be
  // discarded — suspended, interrupted, or superseded — so this is
  // work in progress, not necessarily what anyone can see.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const rendered = React.useRef<TSelected>(undefined as TSelected)
  // What actually reached the screen: the selection, and the selector and
  // comparator that produced it. Kept together, because comparing a value from
  // one selector against a value from another is meaningless. Boxed so that a
  // committed `undefined` is distinguishable from having committed nothing yet.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const committed = React.useRef<
    | {
        value: TSelected
        selector: (state: RouterState<any>) => TSelected
        compare: (a: TSelected, b: TSelected) => boolean
      }
    | undefined
  >(undefined)

  rendered.current = selector(resolveFrame(scope, presenting.frameId))

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLayoutEffect(() => {
    committed.current = { value: rendered.current, selector, compare }
  })

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLayoutEffect(() => {
    // Accept a publication only when this subscriber's own selection changed,
    // which is what keeps selector-level render counts identical to the store
    // path. A consumer that declines stays on the committed publication, where
    // its selection is by definition the same.
    //
    // Everything compared here comes from the committed render, never the one
    // in progress: a discarded render leaves behind a selection, and a
    // selector, that were never presented. Comparing against either would skip
    // the re-render that should have shown the frame, leaving this consumer
    // stuck on what is on screen.
    // Re-read the publication this consumer is already presenting, without
    // moving it onto another one. Used for every notification that is not an
    // offer, and when the subscription is installed.
    const refresh = () => {
      const onScreen = committed.current
      if (!onScreen) {
        return
      }
      setPresenting((previous) => {
        const next = onScreen.selector(resolveFrame(scope, previous.frameId))
        return onScreen.compare(onScreen.value, next)
          ? previous
          : { ...previous, revision: previous.revision + 1 }
      })
    }

    const unsubscribe = scope.subscribe((offered) => {
      if (!offered) {
        refresh()
        return
      }
      const onScreen = committed.current
      if (!onScreen) {
        setPresenting((previous) => ({
          frameId: offered.frameId,
          revision: previous.revision + 1,
        }))
        return
      }
      const next = onScreen.selector(offered)
      if (!onScreen.compare(onScreen.value, next)) {
        setPresenting((previous) => ({
          frameId: offered.frameId,
          revision: previous.revision + 1,
        }))
      }
    })

    // A publication can land between this consumer's render and this effect —
    // `MatchesInner` commits a frame from a layout effect of its own — and a
    // notification sent then reaches nobody who is not yet listening. So
    // re-read on subscribing, the way `useSyncExternalStore` does.
    refresh()

    return unsubscribe
  }, [scope])

  return rendered.current
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
