'use client'

import * as React from 'react'
import { isServer } from '@tanstack/router-core/isServer'
import { useLayoutEffect } from './utils'
import type { AnyRouter, RouterState } from '@tanstack/router-core'
import type { CacheableSelector } from './useMatch'

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

/**
 * Everything a router's publications need, closed over that one router.
 *
 * Built outside the component because it belongs to the router, not to a
 * mount: a provider handed a different router has to build a new one rather
 * than keep publishing through the old router's scopes.
 */
function createOwner(router: AnyRouter): RouterStateOwner {
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
      //
      // Progress comes from the head rather than from the frame, because a
      // newer navigation may already be loading by the time this one commits.
      // Committing the frame's own `status`/`isLoading` would replace that
      // navigation's overlay with a stale idle snapshot, and it may emit
      // nothing further until it finishes — leaving progress false throughout.
      const committedFrame = withProgress(
        nextFrame,
        router.stores.__store.get(),
      )
      root.committed = committedFrame
      route.committed = committedFrame
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
  return owner
}

export function RouterStateProvider({
  router,
  children,
}: {
  router: AnyRouter
  children: React.ReactNode
}) {
  // Keyed by router identity. A mounted provider can be handed a different
  // router — a test rerender, HMR, switching tenant — and an owner built for
  // the previous one would keep reading and staging that router's state.
  const ownerRef = React.useRef<RouterStateOwner | undefined>(undefined)
  if (!ownerRef.current || ownerRef.current.router !== router) {
    ownerRef.current = createOwner(router)
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

/**
 * The scope for a reader that has no owner above it for the router it names —
 * `useRouterState({ router })` pointing at another instance, or a consumer
 * rendered outside `RouterProvider`.
 *
 * There is no presentation to isolate here, so this scope presents the store
 * head and treats every notification as a plain refresh: the same content the
 * default `useStore` path gives. Going through the *same* hooks as a scoped
 * reader is the point — the argument can change between renders, and a reader
 * that changed hook shape with it would crash on the hook order rather than
 * merely read a different router. Cached per router so the identity the
 * subscription effect depends on stays stable.
 */
const detachedScopes = new WeakMap<AnyRouter, RouterStateScope>()

function detachedScope(router: AnyRouter): RouterStateScope {
  const existing = detachedScopes.get(router)
  if (existing) {
    return existing
  }
  const scope: RouterStateScope = {
    router,
    get committed() {
      return router.stores.__store.get()
    },
    staged: undefined,
    subscribe: (subscriber) => {
      const subscription = router.stores.__store.subscribe(() =>
        subscriber(undefined),
      )
      return () => subscription.unsubscribe()
    },
    notify: () => {},
  }
  detachedScopes.set(router, scope)
  return scope
}

/**
 * Whether this component reads through the frame path, decided once.
 *
 * The option gates which hooks a reader calls, and the router a component
 * reads is not fixed: `useRouterState({ router })` takes one as an option,
 * and a provider can be re-rendered with another. If the answer changed under
 * a mounted component, its hook sequence would change with it and React would
 * fail on the hook order rather than merely read the other router. So it is
 * frozen at first render, and every branch on the option goes through this.
 *
 * A reader frozen on the frame path but later handed a router with no owner
 * resolves to that router's store head; one frozen on the store path reads
 * the head directly. Either way it reads the right router's state — it just
 * keeps the isolation behaviour it mounted with.
 */
export function useFrameMode(router: AnyRouter): boolean {
  const [mode] = React.useState(() =>
    Boolean(router.options.experimental_concurrentRenderFrames),
  )
  return mode
}

export function useRouterStateSelector<TSelected>(
  router: AnyRouter,
  selector: CacheableSelector<RouterState<any>, TSelected>,
  compare: (a: TSelected, b: TSelected) => boolean = defaultCompare,
  /**
   * Filled with a getter for the publication this consumer is presenting, for
   * a caller that needs it outside render — an event handler resolving against
   * the route the user is looking at, say.
   *
   * It has to be a getter rather than a value: a consumer whose selection did
   * not change does not re-render, so anything captured in render would be
   * from whichever navigation last moved its selection. Reading at call time
   * gives the staged publication while this consumer is presenting one, and
   * the committed publication otherwise — which for a consumer that sat out a
   * navigation is the route now on screen.
   */
  presentedFrame?: React.MutableRefObject<(() => RouterRenderFrame) | undefined>,
): TSelected {
  const ownerScope = React.useContext(routerStateScopeContext)
  // Not conditional on anything that can change: whichever scope this reader
  // resolves to, the hooks below run, in this order, on every render.
  const scope =
    ownerScope && ownerScope.router === router
      ? ownerScope
      : detachedScope(router)

  if (isServer ?? router.isServer) {
    // One render, no reactivity, so nothing to subscribe to. `offeredFrame` is
    // what the client path would resolve on its first render.
    return selector(offeredFrame(scope))
  }

  // Which publication this consumer is presenting. It lives in React state, so
  // React versions it per tree: a work-in-progress render can accept the staged
  // publication without the still-visible tree following it there. `revision`
  // makes every accepted update a distinct state value, so a progress-only
  // change — same frame, new status — still re-renders.
  //
  // The scope is part of it because `frameId` only means anything within one:
  // a different router counts frames from its own start, so an identity
  // carried over could collide and read as this consumer having accepted a
  // frame it was never offered. A scope change starts the identity over —
  // rebased rather than reset, so `revision` stays monotonic and a pending
  // update cannot land on a value React considers unchanged.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [stored, setPresenting] = React.useState(() => ({
    scope,
    frameId: offeredFrame(scope).frameId,
    revision: 0,
  }))
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const rebase = React.useCallback(
    (previous: { scope: RouterStateScope; frameId: number; revision: number }) =>
      previous.scope === scope
        ? previous
        : {
            scope,
            frameId: offeredFrame(scope).frameId,
            revision: previous.revision,
          },
    [scope],
  )
  const presenting = rebase(stored)
  // The publication this consumer is presenting, for `presentedFrame` to read
  // after the fact. Updated at commit, so it describes the tree on screen
  // rather than a render that may yet be discarded.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const presentingRef = React.useRef(presenting)
  // What actually reached the screen: the selection, and the selector and
  // comparator that produced it. Kept together, because comparing a value from
  // one selector against a value from another is meaningless. Boxed so that a
  // committed `undefined` is distinguishable from having committed nothing yet.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const committed = React.useRef<
    | {
        value: TSelected
        selector: CacheableSelector<RouterState<any>, TSelected>
        compare: (a: TSelected, b: TSelected) => boolean
      }
    | undefined
  >(undefined)

  // The selection for the render currently executing. A render can be
  // discarded — suspended, interrupted, or superseded — so this is work in
  // progress, not necessarily what anyone can see; it is a plain local, and
  // the effect below closes over it, so each render carries its own. Holding
  // it in a ref instead would let a later render overwrite it before an
  // earlier one commits, and the earlier tree's effect would then record a
  // selection that was never on its screen — enough to skip a re-render it
  // needed.
  const rendered = selector(resolveFrame(scope, presenting.frameId))

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLayoutEffect(() => {
    committed.current = { value: rendered, selector, compare }
    presentingRef.current = presenting
  })

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const getPresentedFrame = React.useCallback(
    () => resolveFrame(scope, presentingRef.current.frameId),
    [scope],
  )
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLayoutEffect(() => {
    if (!presentedFrame) {
      return
    }
    presentedFrame.current = getPresentedFrame
    return () => {
      presentedFrame.current = undefined
    }
  }, [getPresentedFrame, presentedFrame])

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
    // Whether the selection this consumer has on screen still holds for
    // `frame`.
    //
    // A selector and a comparator are user code, and this runs them outside
    // React's render — from the Router's `startTransition`, by way of
    // `notify`. A throw here would reach neither an error boundary (there is
    // no component on the stack) nor the consumer that owns the selector; it
    // would unwind into whichever navigation sent the notification and wedge
    // it. So a throwing selector is read as "the selection changed": this
    // consumer re-renders, the selector throws during render instead, and the
    // nearest error boundary handles it the way it would on the store path.
    const stillHolds = (
      onScreen: NonNullable<typeof committed.current>,
      frame: RouterRenderFrame,
    ) => {
      // A structural-sharing selector caches its last result to keep the
      // selection referentially stable, and this runs it against a
      // publication that may never commit. Writing that cache here would
      // leave the still-visible tree comparing against a result it never
      // rendered, and it would return a fresh object next time — breaking
      // the stability the option promises. So the cache is put back
      // afterwards; a consumer that accepts the offer re-renders and writes
      // it for real.
      const cached = onScreen.selector.snapshotCache?.()
      try {
        return onScreen.compare(onScreen.value, onScreen.selector(frame))
      } catch {
        return false
      } finally {
        onScreen.selector.restoreCache?.(cached)
      }
    }

    // Decided here rather than inside the updater: `stillHolds` runs user code
    // and borrows the selector's cache, and React may call an updater more than
    // once — twice in Strict Mode — so a side-effecting one would run the
    // selector more often than there were notifications. It also has to answer
    // for the publication this notification described, which an updater
    // running later might not resolve to.
    const refresh = () => {
      const onScreen = committed.current
      if (!onScreen) {
        return
      }
      if (stillHolds(onScreen, resolveFrame(scope, presentingRef.current.frameId))) {
        return
      }
      setPresenting((previous) => {
        const base = rebase(previous)
        return { ...base, revision: base.revision + 1 }
      })
    }

    const unsubscribe = scope.subscribe((offered) => {
      if (!offered) {
        refresh()
        return
      }
      const onScreen = committed.current
      if (onScreen && stillHolds(onScreen, offered)) {
        return
      }
      setPresenting((previous) => ({
        scope,
        frameId: offered.frameId,
        revision: rebase(previous).revision + 1,
      }))
    })

    // A publication can land between this consumer's render and this effect —
    // `MatchesInner` commits a frame from a layout effect of its own — and a
    // notification sent then reaches nobody who is not yet listening. So
    // re-read on subscribing, the way `useSyncExternalStore` does.
    refresh()

    return unsubscribe
  }, [rebase, scope])

  return rendered
}

/**
 * Whether this render should consolidate route suspension at the frame root.
 *
 * Answered from the option and whether the app renders on the server, both
 * fixed for the tree's lifetime — deliberately, because this decides an
 * element *type*. It first followed hydration, which meant the wrapper at the
 * root of the route tree changed from a fragment to a `Suspense` boundary the
 * moment hydration finished: React reads a changed type as a replacement, so
 * the whole route subtree unmounted and remounted, re-running mount effects
 * and discarding anything a component had set up while hydrating.
 *
 * A server-rendered app therefore does not consolidate at all. It keeps
 * upstream's route-level boundaries, which is what its streamed HTML already
 * describes, and gives up atomic acknowledgement: a child that suspends
 * resolves at its own boundary, so a frame can be acknowledged while part of
 * the tree is still pending. That is upstream's behaviour today, and a far
 * better trade than remounting the route tree once per page load.
 */
export function useFrameRootBoundary(
  router: AnyRouter,
  isServerRender: boolean,
): boolean {
  return useFrameMode(router) && !isServerRender && !router.ssr
}
