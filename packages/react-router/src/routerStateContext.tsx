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
  /**
   * The staged frame still waiting to be acknowledged, if any.
   *
   * An owner outlives the tree that was going to acknowledge its staged
   * frame — the provider can unmount mid-navigation and mount again on the
   * same router. A fresh `Matches` seeds its consumers from `staged`, so it
   * renders that frame while acknowledging against the committed one, and
   * nothing ever settles: the owner stays gated on `pending` and the router
   * stays `pending` with it. Exposing it lets the new tree adopt the frame it
   * is already rendering.
   */
  pending: RouterRenderFrame | undefined
  /** Bring a cached owner back in step with the router before it is read. */
  resync: () => void
  begin: () => void
  /**
   * Offer a frame for this publication, or `undefined` when the publication
   * was re-entered and the aggregate no longer describes one of them.
   */
  stage: (frame: RouterRenderFrame) => RouterRenderFrame | undefined
  cancel: () => void
  commit: (frame: RouterRenderFrame) => boolean
  publish: () => void
}

const defaultCompare = (a: unknown, b: unknown) => a === b

/**
 * The publication a fresh reader at this position should start from.
 *
 * A staged publication the head has already left is not offered. Cancelling
 * one runs from the store subscription a provider holds, so while no provider
 * was mounted nothing dropped it — and seeding from it would mount the route
 * it names: descendant effects run before the provider's, so a `<Navigate>`
 * in that route would fire a redirect from a frame nothing ever acknowledged.
 */
function offeredFrame(scope: RouterStateScope): RouterRenderFrame {
  const staged = scope.staged
  if (!staged) {
    return scope.committed
  }
  return isSuperseded(staged, scope.router.stores.__store.get())
    ? scope.committed
    : staged
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

/**
 * Whether two locations are the same position in history.
 *
 * The history key is compared as well as the href, because a replacement can
 * target the same URL with different state — same href, different entry. Both
 * places that ask "has the location moved?" go through this, so neither can
 * drift into comparing less than the other: the supersession guard, and the
 * seed that decides whether a fresh owner's head is coherent.
 */
function sameLocation(
  a: RouterRenderFrame['location'],
  b: RouterRenderFrame['location'],
): boolean {
  return a.href === b.href && a.state.__TSR_key === b.state.__TSR_key
}

/**
 * Whether the head has moved away from a staged publication.
 *
 * The location decides this rather than the frame identity: a publication that
 * changes matches without moving the location, a background refresh say, is
 * not a supersession, and treating it as one would wedge the navigation it
 * belongs to.
 */
function isSuperseded(
  frame: RouterRenderFrame,
  head: RouterRenderFrame,
): boolean {
  return !sameLocation(head.location, frame.location)
}

/**
 * Overlay navigation progress onto a publication without changing its content.
 *
 * Deliberately keeps the publication's `frameId`. That identity is what an
 * acknowledgement is matched against, so a new one here would orphan the
 * render presenting this publication — and it identifies route content, which
 * progress is not. Two states can therefore share a `frameId` and differ in
 * `status`, which the `RouterState` docs state as part of the contract.
 */
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
 * The frame-path decision this provider tree mounted with.
 *
 * It lives beside the owner rather than on it because the owner belongs to a
 * router and the decision belongs to the mounted tree. A provider handed a
 * router configured the other way installs an owner whose own mode disagrees;
 * the tree keeps staging and acknowledging frames, so a reader mounting after
 * that swap has to take the tree's answer, not the replacement owner's, or it
 * subscribes to the head inside a tree that is still presenting the committed
 * publication.
 */
type RouterStateFrameMode = {
  /** The router this tree is rendering. */
  router: AnyRouter
  /** The decision that tree mounted with. */
  frameMode: boolean
}

const routerStateFrameModeContext = React.createContext<
  RouterStateFrameMode | undefined
>(undefined)

/**
 * Publish a tree's frame-path decision without owning frames for it.
 *
 * The store path needs this too. Only the frame path builds an owner, so
 * without publishing the decision on both arms a reader mounting after the
 * option changed would read the option afresh and freeze the other answer
 * from the tree around it.
 */
export function RouterStateFrameMode({
  router,
  frameMode,
  children,
}: {
  router: AnyRouter
  frameMode: boolean
  children: React.ReactNode
}) {
  const value = React.useMemo(
    () => ({ router, frameMode }),
    [router, frameMode],
  )
  return (
    <routerStateFrameModeContext.Provider value={value}>
      {children}
    </routerStateFrameModeContext.Provider>
  )
}

/**
 * The store-path arm of `RouterContextProvider`.
 *
 * Publishes the frozen decision the way the frame arm does, and clears any
 * owner and scope inherited from an ancestor provider. A store-path tree owns
 * no frames, and `Transitioner` takes its owner from context without
 * consulting the mode — so a store-path provider nested under a frame-path one
 * would drive *that* router's owner with this router's publications, writing a
 * `frameId` into this router's acknowledgement slot where its `Matches`
 * expects a set of matches. Its navigations then never settle and the outer
 * router's staged frame is replaced by one assembled from the wrong store.
 */
export function RouterStateStorePath({
  router,
  children,
}: {
  router: AnyRouter
  children: React.ReactNode
}) {
  return (
    <routerStateOwnerContext.Provider value={undefined}>
      <routerStateScopeContext.Provider value={undefined}>
        <RouterStateFrameMode router={router} frameMode={false}>
          {children}
        </RouterStateFrameMode>
      </routerStateScopeContext.Provider>
    </routerStateOwnerContext.Provider>
  )
}

/**
 * Everything a router's publications need, closed over that one router.
 *
 * Built outside the component because it belongs to the router, not to a
 * mount: a provider handed a different router has to build a new one rather
 * than keep publishing through the old router's scopes.
 */
/**
 * The publication a brand-new owner starts from.
 *
 * An owner can be built while a navigation is already in flight — a provider
 * mounted mid-navigation, or a router that committed its matches on the store
 * path before the option was turned on. The head is not a snapshot of one
 * publication then: `location` is already the destination, and once a pending
 * lane publishes `matches` is the destination's too, while `resolvedLocation`
 * still names the route on screen. Seeding from any mixture of those shows a
 * route under the wrong URL for the whole load.
 *
 * So the seed is the *last committed publication*, which is exactly what a
 * tree that had stayed mounted through this navigation would be presenting:
 * `router._committed` is the set of matches `resolvedLocation` was resolved
 * for, and the two are written together. Mounting midway is then not a
 * different experience from having been there.
 *
 * Three earlier revisions of this function tried to reconstruct that pair
 * from the head — substituting `resolvedLocation`, then comparing the history
 * key, then comparing the deepest match's pathname to tell a published
 * pending lane apart. Each missed a case the next review found, the last
 * being a same-path search navigation where the pathname cannot distinguish
 * them at all. Reading the committed publication directly removes the
 * guesswork rather than adding a fourth discriminator.
 *
 * The head's `frameId` is kept. Nothing acknowledges a seeded frame — it is
 * only ever replaced by the next `publish` or `stage` — and a navigation that
 * commits changes the matches, so the head's identity advances past it.
 */
function initialFrame(router: AnyRouter): RouterRenderFrame {
  const head = router.stores.__store.get()
  const resolved = router.stores.resolvedLocation.get()
  const committed = router._committed
  // When the location has not moved there is no navigation to be mid-way
  // through: the head is a single publication, and any matches newer than
  // `_committed` — a background refresh, say — are the ones to show.
  if (!resolved || !committed.length || sameLocation(resolved, head.location)) {
    return head
  }
  return { ...head, location: resolved, matches: committed }
}

function createOwner(router: AnyRouter): RouterStateOwner {
  const initial = initialFrame(router)
  const root = createScope(router, initial)
  const route = createScope(router, initial)
  let staging = false
  let pending: RouterRenderFrame | undefined
  let publicationTx: AnyRouter['_tx']

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
    get pending() {
      // Only while the head still names it. A tree adopting this frame is one
      // that was never offered it — it mounted, or returned to this router —
      // and nothing cancelled it in between, because cancelling happens from
      // the store subscription a provider holds and there may have been no
      // provider to hold one. Adopting it then would acknowledge and commit a
      // route the head has already left, and `publish` could no longer
      // recognise it as pending in order to drop it.
      if (!pending) {
        return undefined
      }
      return isSuperseded(pending, router.stores.__store.get())
        ? undefined
        : pending
    },
    resync: () => {
      // An owner outlives every tree that mounts on it, and only a mounted
      // frame-path provider keeps it in step: its layout effect installs the
      // store subscription that drives `publish`. A router mounted on the
      // *store* path in between navigates with nothing driving this owner, so
      // by the next frame-path mount the committed frame can be a whole route
      // behind — and that route renders, and its effects run, before the
      // provider's own effect can publish. A `<Navigate>` in the route the
      // user has left would fire from it.
      //
      // Nothing is notified here. This runs during render, and only ever
      // advances toward the publication `publish` would have reached anyway;
      // where a tree is already mounted and subscribed, that tree has kept the
      // owner current and this is a no-op.
      if (staging || pending || route.staged) {
        return
      }
      const next = initialFrame(router)
      if (
        next.frameId === root.committed.frameId &&
        sameLocation(next.location, root.committed.location)
      ) {
        return
      }
      root.committed = next
      route.committed = next
    },
    begin: () => {
      staging = true
      // The load transaction this publication belongs to. A frame is only
      // assembled after the publication callback returns, and the callback
      // ends by emitting `onLoad` and `onBeforeRouteMount` — user code, which
      // may navigate. Such a navigation moves the location synchronously
      // while the matches this publication just committed are still in the
      // store, so the aggregate read afterwards is not a snapshot of any one
      // publication: it pairs this route's matches with the successor's URL.
      // The transaction identity is what tells them apart, and is the same
      // thing `load-client` itself checks between those two emits.
      publicationTx = router._tx
    },
    stage: (nextFrame) => {
      staging = false
      if (router._tx !== publicationTx) {
        // Re-entered. The aggregate belongs to no single publication, and
        // `isSuperseded` cannot reject it later because its location *is*
        // the head — that is precisely what the successor moved it to. Drop
        // it: consumers keep the last coherent publication, and the
        // successor stages its own frame when its load resolves.
        owner.cancel()
        return undefined
      }
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
      if (isSuperseded(nextFrame, router.stores.__store.get())) {
        // The head left this frame and nothing dropped it. Cancelling runs
        // from the store subscription the provider installs in a layout
        // effect, and layout effects run bottom-up: a tree that adopted the
        // frame during a render React then yielded out of reaches this
        // acknowledgement before that subscription exists, so a navigation
        // starting inside the gap moves the head unobserved.
        //
        // The frame identity alone cannot tell: it still matches `pending`,
        // because the frame is genuinely the one that was staged. Committing
        // it here would put the route the user has already left into both
        // scopes, and clear `pending` so nothing could withdraw it
        // afterwards. Cancel instead, exactly as `publish` would have.
        owner.cancel()
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
      if (pending !== undefined && !staging && isSuperseded(pending, head)) {
        // Superseded before anything rendered it. A staged frame is offered
        // to a tree that may be suspended, and a replacement navigation moves
        // the head without publishing anything of its own until its own load
        // resolves — so the first tree could finish suspending inside that
        // window and commit a destination the URL had already left.
        //
        // Nothing has committed it, so dropping it costs nothing: consumers
        // fall back to the publication they are already presenting, which is
        // the route still on screen, and the successor stages its own frame
        // when it is ready.
        owner.cancel()
        return
      }
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
        // Same route content, so there is nothing to commit — but progress is
        // deliberately not part of the frame id, and a committed frame can
        // carry the progress of a *different* moment: `commit` takes it from
        // the head, which is still 'pending' because the load only settles
        // after the acknowledgement it is waiting on. The idle that follows
        // is then the one notification that would tell consumers the load has
        // finished, and returning here would swallow it.
        syncProgress(head)
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

/**
 * One owner per router, for the router's lifetime.
 *
 * Not a ref on the provider: a ref is shared by every tree rendering it, so a
 * render for another router — one that may be discarded — would replace the
 * owner belonging to the tree still on screen. A later render for the
 * original router would then build a *new* owner, seeded from that router's
 * current store head, which during a staged navigation is the destination:
 * the tree would expose the route being prepared and orphan the
 * acknowledgement the first owner is still waiting on.
 *
 * Keyed weakly, so an owner lives exactly as long as its router. Building one
 * is idempotent per router, so a discarded render costs nothing and a
 * surviving one finds the same owner.
 */
const ownersByRouter = new WeakMap<AnyRouter, RouterStateOwner>()

function ownerFor(router: AnyRouter): RouterStateOwner {
  const existing = ownersByRouter.get(router)
  if (existing) {
    // Cached for the router's lifetime, which outlasts any one tree.
    existing.resync()
    return existing
  }
  const owner = createOwner(router)
  ownersByRouter.set(router, owner)
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
  const owner = ownerFor(router)
  // The tree's decision: the option as it stands when this provider mounts,
  // kept for as long as it is mounted. Read from the router rather than from
  // the owner, because an owner is cached for its router's lifetime — a
  // router that was once mounted with the option off would otherwise be
  // stuck on the store path in every later tree, whatever the option says.
  const [frameMode] = React.useState(() =>
    Boolean(router.options.experimental_concurrentRenderFrames),
  )

  useLayoutEffect(() => {
    const subscription = router.stores.__store.subscribe(() => owner.publish())
    owner.publish()
    return () => subscription.unsubscribe()
  }, [owner, router])

  return (
    <routerStateOwnerContext.Provider value={owner}>
      <RouterStateFrameMode router={router} frameMode={frameMode}>
        <routerStateScopeContext.Provider value={owner.root}>
          {children}
        </routerStateScopeContext.Provider>
      </RouterStateFrameMode>
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

/**
 * The publication this position is presenting, for code that runs outside
 * render — an event handler resolving a navigation against the route the user
 * is looking at, say.
 *
 * Returns a getter, and subscribes to nothing: a scope's identity is stable
 * for the router's lifetime, so reading it costs no re-renders, and an
 * imperative caller wants the answer at call time anyway. It gives the
 * publication on screen: an event is delivered to the committed tree, so that
 * is the one it should resolve against. `undefined` off the frame path, where
 * the router's own head is the right source and already fresh.
 */
export function usePresentedLocation(
  router: AnyRouter,
): (() => RouterRenderFrame['location'] | undefined) | undefined {
  const scope = React.useContext(routerStateScopeContext)
  const frameMode = useFrameMode(router)
  return React.useMemo(() => {
    if (!frameMode || !scope || scope.router !== router) {
      return undefined
    }
    return () => scope.committed.location
  }, [frameMode, router, scope])
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
 * default `useSelector` path gives. Going through the *same* hooks as a scoped
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
  // The tree's own answer is taken where there is one, so a reader mounting
  // after the option moved — or after the provider was handed a router
  // configured the other way — agrees with the tree that is already staging
  // frames rather than with the option's current value. Read once, at this
  // component's first render, and kept, so a later swap cannot change this
  // reader's hook shape underneath it either.
  const tree = React.useContext(routerStateFrameModeContext)
  const [mode] = React.useState(() =>
    tree?.router === router
      ? tree.frameMode
      : Boolean(router.options.experimental_concurrentRenderFrames),
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
  //
  // A structural-sharing selector caches its last result to keep the selection
  // referentially stable, and this render may be one of the discarded ones —
  // so the cache is put back to what committed, and this render's value is
  // published only once it commits, below. Left in place, a discarded render's
  // write describes a selection nobody saw: the still-visible tree's next
  // render would compare its own frame against that, find it different, and
  // hand back a fresh object, taking every memoized child with it. The
  // restore is a write-then-restore of the same ref, so it leaves render as
  // pure as it found it.
  const cachedBeforeRender = selector.snapshotCache?.()
  const rendered = selector(resolveFrame(scope, presenting.frameId))
  selector.restoreCache?.(cachedBeforeRender)

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useLayoutEffect(() => {
    committed.current = { value: rendered, selector, compare }
    presentingRef.current = presenting
    // This render is on screen now, so its selection is the one the next
    // render should keep stable.
    selector.restoreCache?.(rendered)
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
