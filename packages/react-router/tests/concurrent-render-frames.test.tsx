import { afterEach, describe, expect, test } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import * as React from 'react'
import {
  RouterStateProvider,
  useRouterStateOwner,
} from '../src/routerStateContext'
import {
  Link,
  Matches,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useMatchRoute,
  useRouterState,
} from '../src'
import type { AnyRouter } from '@tanstack/router-core'

afterEach(() => {
  window.history.replaceState(null, 'root', '/')
  cleanup()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const MODES: Array<[string, boolean]> = [
  ['store subscriptions', false],
  ['concurrent render frames', true],
]

describe.each(MODES)('%s', (_name, experimental_concurrentRenderFrames) => {
  /**
   * Two consumers with different selections: one that changes on every
   * navigation and one that does not. A fine-grained selector contract means
   * only the first re-renders.
   */
  test('a consumer re-renders only when its own selection changes', async () => {
    const renders = { changing: 0, stable: 0 }

    function ChangingConsumer() {
      const pathname = useRouterState({ select: (s) => s.location.pathname })
      renders.changing++
      return <div data-testid="pathname">{pathname}</div>
    }

    function StableConsumer() {
      // True from the first commit onwards, so it never changes value across
      // these navigations even though the underlying router state does.
      const hasMatches = useRouterState({ select: (s) => s.matches.length > 0 })
      renders.stable++
      return <div data-testid="ready">{String(hasMatches)}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Link to="/">Back</Link>
          <Link to="/posts">Posts</Link>
          <ChangingConsumer />
          <StableConsumer />
          <Outlet />
        </>
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      component: () => <h1>Posts Title</h1>,
    })

    render(
      <RouterProvider
        router={createRouter({
          routeTree: rootRoute.addChildren([indexRoute, postsRoute]),
          experimental_concurrentRenderFrames,
        })}
      />,
    )

    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')

    const before = { ...renders }
    fireEvent.click(screen.getByRole('link', { name: 'Posts' }))
    await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))

    // The selection changed, so this consumer must have re-rendered.
    expect(renders.changing).toBeGreaterThan(before.changing)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/posts')

    // The selection did not change, so this consumer must not have.
    expect(renders.stable).toBe(before.stable)
  })

  /**
   * The reason the consistency boundary lives in the Router adapter: a reader
   * mounted by an urgent update while a navigation is in flight must observe
   * the route that is actually on screen, not the one being prepared.
   */
  test('a consumer mounted during a pending navigation reads the committed route', async () => {
    const gate = deferred()
    let showLateConsumer!: (show: boolean) => void

    function LateConsumer() {
      const pathname = useLocation({ select: (l) => l.pathname })
      return <div data-testid="late">{pathname}</div>
    }

    const rootRoute = createRootRoute({
      component: function RootComponent() {
        const [show, setShow] = React.useState(false)
        showLateConsumer = setShow
        return (
          <>
            <Link to="/slow">Slow</Link>
            {show ? <LateConsumer /> : null}
            <Outlet />
          </>
        )
      },
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => gate.promise,
      component: () => <h1>Slow Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
      // Publish a pending frame immediately, so the reader below really is
      // mounted while a staged successor exists.
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })
    render(<RouterProvider router={router} />)

    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // Begin a navigation that cannot finish yet.
    fireEvent.click(screen.getByRole('link', { name: 'Slow' }))
    // The head state has moved on while the previous route is still on screen:
    // this is the window in which a new reader could observe the wrong route.
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    expect(router.stores.location.get().pathname).toBe('/slow')
    expect(
      screen.getByRole('heading', { name: 'Index Title' }),
    ).toBeInTheDocument()

    // Mount a new reader urgently, while that navigation is still pending.
    act(() => showLateConsumer(true))

    // The frame path agrees with what is visible. The store path does not:
    // `useLocation` reads the mutable head atom, so a reader mounted here sees
    // the route being prepared while the previous one is still on screen.
    // Asserting both pins the difference this option is meant to remove.
    expect(screen.getByTestId('late').textContent).toBe(
      experimental_concurrentRenderFrames ? '/' : '/slow',
    )

    gate.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
    await waitFor(() =>
      expect(screen.getByTestId('late')).toHaveTextContent('/slow'),
    )
  })

  /** A navigation replaced before it resolves must never become visible. */
  test('a superseded navigation does not commit', async () => {
    const first = deferred()
    const second = deferred()

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Link to="/first">First</Link>
          <Link to="/second">Second</Link>
          <Outlet />
        </>
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const firstRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/first',
      loader: () => first.promise,
      component: () => <h1>First Title</h1>,
    })
    const secondRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/second',
      loader: () => second.promise,
      component: () => <h1>Second Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, firstRoute, secondRoute]),
      experimental_concurrentRenderFrames,
    })
    render(<RouterProvider router={router} />)

    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    fireEvent.click(screen.getByRole('link', { name: 'First' }))
    fireEvent.click(screen.getByRole('link', { name: 'Second' }))

    // Resolve the superseded navigation last, so it would win on ordering
    // alone if the newer frame were not gating the commit.
    second.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Second Title' }))
    first.resolve()

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Second Title' }),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('heading', { name: 'First Title' })).toBeNull()
    expect(router.state.location.pathname).toBe('/second')
  })
})

describe('concurrent render frames', () => {
  /**
   * A reader mounted outside the route tree by an unrelated urgent update must
   * agree with what is on screen. This is the failure that motivates the whole
   * design: a menu, toast, or modal opened while a route is suspending would
   * otherwise render against a route the user cannot see.
   */
  test('a reader outside the route tree does not read ahead of the visible route', async () => {
    let releaseNext: () => void = () => {}
    let nextReady = false
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = () => {
        nextReady = true
        resolve()
      }
    })

    function NextPage() {
      if (!nextReady) {
        throw nextGate
      }
      return <h1>Next Title</h1>
    }

    function PresentedPath() {
      const pathname = useRouterState({ select: (s) => s.location.pathname })
      return <div data-testid="presented">{pathname}</div>
    }

    const rootRoute = createRootRoute({
      component: () => <Outlet />,
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      component: NextPage,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
      experimental_concurrentRenderFrames: true,
    })

    function TestApp() {
      const [show, setShow] = React.useState(false)
      return (
        <RouterContextProvider router={router}>
          <button type="button" onClick={() => setShow(true)}>
            Show presented path
          </button>
          {show ? <PresentedPath /> : null}
          <Matches />
        </RouterContextProvider>
      )
    }

    render(<TestApp />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // The imperative head advances while the route it names suspends.
    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/next' })
    })
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/next'),
    )
    expect(screen.getByRole('heading', { name: 'Index Title' })).toBeVisible()

    // An urgent update, unrelated to routing, mounts a reader.
    fireEvent.click(screen.getByRole('button', { name: 'Show presented path' }))

    expect(screen.getByTestId('presented').textContent).toBe('/')

    await act(async () => {
      releaseNext()
      await nextGate
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Next Title' }))
    await waitFor(() =>
      expect(screen.getByTestId('presented').textContent).toBe('/next'),
    )
  })

  /**
   * Navigation progress is not route content: a global indicator sitting
   * outside the route tree must still see a navigation start and finish, even
   * though that scope deliberately stays on the committed route.
   */
  test('navigation progress reaches a consumer outside the route tree', async () => {
    const gate = deferred()

    function Progress() {
      const isLoading = useRouterState({ select: (s) => s.isLoading })
      return <div data-testid="loading">{String(isLoading)}</div>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => gate.promise,
      component: () => <h1>Slow Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })

    render(
      <RouterContextProvider router={router}>
        <Progress />
        <Matches />
      </RouterContextProvider>,
    )
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    )

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/slow' })
    })

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('true'),
    )

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    )
  })

  /**
   * The same isolation, one level in. A reader that sits *inside* the visible
   * route and re-renders for an unrelated urgent reason — a keystroke, a
   * timer, a local toggle — must keep observing the route on screen. The
   * staged publication belongs to the render that is presenting it, and that
   * render has not committed yet.
   */
  test('a reader inside the visible route does not read ahead when re-rendered urgently', async () => {
    let releaseNext: () => void = () => {}
    let nextReady = false
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = () => {
        nextReady = true
        resolve()
      }
    })

    function NextPage() {
      if (!nextReady) {
        throw nextGate
      }
      return <h1>Next Title</h1>
    }

    function IndexPage() {
      const [bumps, setBumps] = React.useState(0)
      const pathname = useRouterState({ select: (s) => s.location.pathname })
      return (
        <>
          <h1>Index Title</h1>
          <button type="button" onClick={() => setBumps((n) => n + 1)}>
            Bump
          </button>
          <div data-testid="inside">{`${pathname}|${bumps}`}</div>
        </>
      )
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: IndexPage,
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      component: NextPage,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('inside').textContent).toBe('/|0')

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/next' })
    })
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/next'),
    )
    expect(screen.getByRole('heading', { name: 'Index Title' })).toBeVisible()

    // An urgent update inside the still-visible route. It must not drag the
    // staged route into a tree that has not committed it.
    fireEvent.click(screen.getByRole('button', { name: 'Bump' }))
    expect(screen.getByTestId('inside').textContent).toBe('/|1')

    await act(async () => {
      releaseNext()
      await nextGate
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Next Title' }))
  })

  /**
   * Progress is not route content, so it has to cross the presentation
   * boundary: a spinner rendered by the visible route must still see the
   * navigation it is waiting on.
   */
  test('navigation progress reaches a consumer inside the route tree', async () => {
    const gate = deferred()

    function Progress() {
      const isLoading = useRouterState({ select: (s) => s.isLoading })
      return <div data-testid="loading">{String(isLoading)}</div>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <>
          <h1>Index Title</h1>
          <Progress />
        </>
      ),
    })
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => gate.promise,
      component: () => <h1>Slow Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    )

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/slow' })
    })

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('true'),
    )

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
  })

  /**
   * The isolation depends on the staged publication being *offered* only from
   * inside the Router's `startTransition`. Progress notifications do not come
   * from there — they come from the store's subscription, on an urgent lane —
   * so an offer sent from one would pull the visible tree onto a route that has
   * not committed.
   *
   * This guards the property rather than reproducing a failure: today the head
   * stays `pending` for exactly as long as a frame is staged, so a progress
   * change cannot occur inside that window and the notification never fires.
   * The protocol should not depend on that coincidence, and this test fails if
   * a future change makes progress movable while a frame is staged without
   * keeping offers transition-scoped.
   */
  test('a progress notification during a staged navigation cannot move the visible route', async () => {
    const gate = deferred()
    let releaseNext: () => void = () => {}
    let nextReady = false
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = () => {
        nextReady = true
        resolve()
      }
    })

    function NextPage() {
      if (!nextReady) {
        throw nextGate
      }
      return <h1>Next Title</h1>
    }

    function Inside() {
      const pathname = useRouterState({ select: (s) => s.location.pathname })
      return <div data-testid="inside">{pathname}</div>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <>
          <h1>Index Title</h1>
          <Inside />
        </>
      ),
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      component: NextPage,
    })
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/slow',
      loader: () => gate.promise,
      component: () => <h1>Slow Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute, slowRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('inside').textContent).toBe('/')

    // Stage a navigation whose route suspends, so `/next` sits in the staged
    // slot with the previous route still on screen.
    let first!: Promise<void>
    act(() => {
      first = router.navigate({ to: '/next' })
    })
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/next'),
    )
    expect(screen.getByTestId('inside').textContent).toBe('/')

    // Now move progress while that navigation is still suspended. The
    // notification this produces is urgent, and must not carry the staged
    // route with it.
    let second!: Promise<void>
    act(() => {
      second = router.navigate({ to: '/slow' })
    })
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))

    expect(screen.getByTestId('inside').textContent).toBe('/')

    releaseNext()
    gate.resolve()
    await act(async () => {
      await nextGate
      await gate.promise
    })
    await first.catch(() => {})
    await second.catch(() => {})
  })

  /**
   * A mounted provider can be handed a different router — a test rerender,
   * HMR, switching tenant. The frame owner closes over the router it was built
   * for, so it has to be rebuilt, or every publication after the swap goes
   * through the previous router's scopes.
   *
   * Asserted on the owner rather than through a rendered navigation: swapping
   * the `router` prop of a mounted `RouterProvider` does not work upstream
   * either — with `experimental_concurrentRenderFrames` off, the same swap
   * renders an empty tree — so there is no end-to-end behaviour to compare
   * against. This pins the part that is this change's to get right.
   */
  /**
   * A frame is offered to every subscribed consumer, so an `Outlet` belonging
   * to a route the next frame drops still runs its selector against that
   * frame. Reading its own match unconditionally threw there, and because a
   * scope notifies its subscribers in a plain loop, the throw stopped every
   * later consumer being offered the frame — so `Matches` never acknowledged
   * it and the navigation stayed pending for good.
   */
  test('a route leaving the match tree does not wedge the navigation', async () => {
    const rootRoute = createRootRoute({
      component: () => <Outlet />,
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    // A route with its own Outlet: navigating away from its child drops both
    // this route and the nested one from the match tree.
    const nestedRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/nested',
      component: () => (
        <div>
          <h1>Nested Title</h1>
          <Outlet />
        </div>
      ),
    })
    const nestedChildRoute = createRoute({
      getParentRoute: () => nestedRoute,
      path: '/child',
      component: () => <h2>Nested Child Title</h2>,
    })
    const siblingRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/sibling',
      component: () => <h1>Sibling Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([
        indexRoute,
        nestedRoute.addChildren([nestedChildRoute]),
        siblingRoute,
      ]),
      experimental_concurrentRenderFrames: true,
    })

    render(
      <RouterContextProvider router={router}>
        <Matches />
      </RouterContextProvider>,
    )
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    let toChild!: Promise<void>
    act(() => {
      toChild = router.navigate({ to: '/nested/child' })
    })
    await waitFor(() =>
      screen.getByRole('heading', { name: 'Nested Child Title' }),
    )
    await toChild

    // The sibling's match tree has neither /nested nor /nested/child in it.
    let toSibling!: Promise<void>
    act(() => {
      toSibling = router.navigate({ to: '/sibling' })
    })

    await waitFor(() => screen.getByRole('heading', { name: 'Sibling Title' }))
    await toSibling
    expect(router.stores.status.get()).toBe('idle')
  })

  test('a provider handed a different router builds an owner for it', async () => {
    const owners: Array<AnyRouter | undefined> = []

    function OwnerProbe() {
      const owner = useRouterStateOwner()
      owners.push(owner?.router)
      return null
    }

    const makeRouter = () => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> })
      const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <h1>Index Title</h1>,
      })
      return createRouter({
        routeTree: rootRoute.addChildren([indexRoute]),
        experimental_concurrentRenderFrames: true,
      })
    }

    const first = makeRouter()
    const second = makeRouter()

    const { rerender } = render(
      <RouterStateProvider router={first}>
        <OwnerProbe />
      </RouterStateProvider>,
    )
    expect(owners.at(-1)).toBe(first)

    rerender(
      <RouterStateProvider router={second}>
        <OwnerProbe />
      </RouterStateProvider>,
    )
    expect(owners.at(-1)).toBe(second)

    // And back, to pin that identity is what decides it rather than a one-shot
    // "has the router ever changed" flag.
    rerender(
      <RouterStateProvider router={first}>
        <OwnerProbe />
      </RouterStateProvider>,
    )
    expect(owners.at(-1)).toBe(first)
  })
})

/**
 * Frame-path-only hazards: both are about the frame path's extra machinery,
 * and neither has an analogue on the store path, so they are pinned once
 * rather than through the mode matrix.
 */
describe('concurrent render frames', () => {
  const makeRouter = (frames = true, initialPath?: string) => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      component: () => <h1>Posts Title</h1>,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute, postsRoute]),
      experimental_concurrentRenderFrames: frames,
      // A memory history where a distinct starting location is wanted: both
      // routers would otherwise read the same browser history and agree,
      // which would hide a reader following the owner instead of the router
      // it was handed.
      ...(initialPath
        ? { history: createMemoryHistory({ initialEntries: [initialPath] }) }
        : {}),
    })
  }

  /**
   * `useRouterState({ router })` names a router explicitly, and that argument
   * can change between renders. A reader whose hook shape depended on whether
   * the named router matched the owner above it would not merely read the
   * other router — it would crash on the hook order.
   */
  test('a consumer whose router argument changes keeps its hook order', async () => {
    const first = makeRouter()
    // Starts somewhere else, so the assertions say *which* router was read.
    const second = makeRouter(true, '/posts')
    // Configured the other way, so the swap crosses the option itself and not
    // just scope identity.
    const plain = makeRouter(false)

    function Probe({ router }: { router: AnyRouter }) {
      const pathname = useRouterState({
        router,
        select: (state) => state.location.pathname,
      })
      return <div data-testid="pathname">{pathname}</div>
    }

    // `second` has no owner above it here, so it resolves to a different scope
    // than `first` does — and it is at `/posts`, so this also pins that the
    // reader followed the router it was handed rather than the owner above it.
    const { rerender } = render(
      <RouterContextProvider router={first}>
        <RouterStateProvider router={first}>
          <Probe router={second} />
        </RouterStateProvider>
      </RouterContextProvider>,
    )
    expect(screen.getByTestId('pathname')).toHaveTextContent('/posts')

    const swap = (router: AnyRouter) =>
      rerender(
        <RouterContextProvider router={first}>
          <RouterStateProvider router={first}>
            <Probe router={router} />
          </RouterStateProvider>
        </RouterContextProvider>,
      )

    // Onto the scoped router, and back off it: either direction changes hook
    // order if the branch is taken per render.
    swap(first)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')
    swap(second)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/posts')
    // And onto a router that is not on the frame path at all, which decides
    // the branch above `useRouterStateSelector` rather than inside it.
    swap(plain)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')
    swap(first)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')
  })


  /**
   * A link's `href` is built from the location it is rendered against, which
   * on the frame path is the one on screen rather than the router's head. The
   * click has to resolve against that same location, or a functional `search`
   * updater sends the user somewhere other than where the href they saw
   * pointed.
   */
  test('a click resolves against the location the href was built from', async () => {
    const gate = deferred()
    let loads = 0

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Link
            to="/posts"
            search={(prev: any) => ({ page: (prev.page ?? 1) + 1 })}
          >
            Next page
          </Link>
          <Outlet />
        </>
      ),
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      validateSearch: (search: Record<string, unknown>) => ({
        page: Number(search.page ?? 1),
      }),
      // The search is part of the loader key, so each page really loads.
      loaderDeps: ({ search }: { search: { page: number } }) => ({
        page: search.page,
      }),
      // Every load after the first one hangs until the test lets it through,
      // which is the window in which the visible route and the head disagree.
      loader: async () => {
        loads++
        if (loads > 1) {
          await gate.promise
        }
      },
      component: () => {
        const page = postsRoute.useSearch({ select: (s) => s.page })
        return <h1>{`Posts ${page}`}</h1>
      },
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([postsRoute]),
      experimental_concurrentRenderFrames: true,
    })

    window.history.replaceState(null, '', '/posts?page=1')
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Posts 1' }))

    const link = () => screen.getByRole('link', { name: 'Next page' })
    expect(link()).toHaveAttribute('href', '/posts?page=2')

    // Head moves to page 5 and stays pending, so the head and the visible
    // route disagree about what "the next page" is.
    act(() => {
      void router.navigate({ to: '/posts', search: { page: 5 } })
    })
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    screen.getByRole('heading', { name: 'Posts 1' })
    expect(link()).toHaveAttribute('href', '/posts?page=2')

    act(() => {
      fireEvent.click(link())
    })
    gate.resolve()

    await waitFor(() => screen.getByRole('heading', { name: 'Posts 2' }))
    expect(router.stores.location.get().search).toEqual({ page: 2 })
  })


  /**
   * The other half of that: a link whose href does not change does not
   * re-render, so anything its render captured is from whichever navigation
   * last moved it. The location has to be read when the click happens.
   */
  test('a click resolves against the current location when the href never changed', async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Link
            to="/posts"
            search={{ page: 9 }}
            state={(prev: any) => ({ from: prev.__TSR_index })}
          >
            Fixed target
          </Link>
          <Outlet />
        </>
      ),
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      validateSearch: (search: Record<string, unknown>) => ({
        page: Number(search.page ?? 1),
      }),
      component: () => {
        const page = postsRoute.useSearch({ select: (s) => s.page })
        return <h1>{`Posts ${page}`}</h1>
      },
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([postsRoute]),
      experimental_concurrentRenderFrames: true,
    })

    window.history.replaceState(null, '', '/posts?page=1')
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Posts 1' }))

    const link = () => screen.getByRole('link', { name: 'Fixed target' })
    // Static search, so this href is the same before and after the navigation
    // below and the link has no reason to re-render.
    expect(link()).toHaveAttribute('href', '/posts?page=9')

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/posts', search: { page: 2 } })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Posts 2' }))
    await navigation
    expect(link()).toHaveAttribute('href', '/posts?page=9')

    const indexOnScreen = (router.stores.location.get().state as any).__TSR_index

    act(() => {
      fireEvent.click(link())
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Posts 9' }))
    // The updater ran against the location that was on screen when it was
    // clicked, not the one the link last rendered against.
    expect((router.stores.location.get().state as any).from).toBe(indexOnScreen)
  })


  /**
   * Structural sharing promises a referentially stable selection. Deciding
   * whether an offer changed a consumer's selection runs its selector outside
   * render, against a publication that may never commit, so that decision must
   * not leave its cache describing a render nobody saw.
   */
  test('an offer does not disturb a structural-sharing selection', async () => {
    let releaseNext: () => void = () => {}
    let nextReady = false
    const nextGate = new Promise<void>((resolve) => {
      releaseNext = () => {
        nextReady = true
        resolve()
      }
    })

    function NextPage() {
      if (!nextReady) {
        throw nextGate
      }
      return <h1>Next Title</h1>
    }

    const selections: Array<{ pathname: string }> = []

    function IndexPage() {
      const [bumps, setBumps] = React.useState(0)
      // An object selection, so structural sharing is what keeps its identity
      // stable across renders that do not change it.
      const selected = useRouterState({
        structuralSharing: true,
        select: (state) => ({ pathname: state.location.pathname }),
      })
      selections.push(selected)
      return (
        <>
          <h1>Index Title</h1>
          <button type="button" onClick={() => setBumps((n) => n + 1)}>
            Bump
          </button>
          <div data-testid="inside">{`${selected.pathname}|${bumps}`}</div>
        </>
      )
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: IndexPage,
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      component: NextPage,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    const onScreen = selections.at(-1)!

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/next' })
    })
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/next'),
    )

    // The staged route is suspended, so the visible tree is still the one on
    // screen. Re-render it urgently: its selection is unchanged, so it must be
    // the same object it rendered before.
    fireEvent.click(screen.getByRole('button', { name: 'Bump' }))
    expect(screen.getByTestId('inside').textContent).toBe('/|1')
    expect(selections.at(-1)).toBe(onScreen)

    await act(async () => {
      releaseNext()
      await nextGate
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Next Title' }))
  })


  /**
   * A destination indicator asks about the navigation in flight, so it
   * resolves against the head. A second navigation starting while the first is
   * still pending moves only the head location — no frame is staged, and the
   * presented one is identical — so nothing would re-render it.
   */
  test('a pending matcher follows the head when a navigation is superseded', async () => {
    const first = deferred()
    const second = deferred()

    function Indicator() {
      const matchRoute = useMatchRoute()
      const toFirst = !!matchRoute({ to: '/first', pending: true })
      const toSecond = !!matchRoute({ to: '/second', pending: true })
      return <div data-testid="target">{`${toFirst}|${toSecond}`}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Indicator />
          <Outlet />
        </>
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const firstRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/first',
      loader: () => first.promise,
      component: () => <h1>First Title</h1>,
    })
    const secondRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/second',
      loader: () => second.promise,
      component: () => <h1>Second Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, firstRoute, secondRoute]),
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('target').textContent).toBe('false|false')

    act(() => {
      void router.navigate({ to: '/first' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('target').textContent).toBe('true|false'),
    )

    // Supersede it. `status` stays 'pending' throughout, so the only thing
    // that moves is the head location.
    act(() => {
      void router.navigate({ to: '/second' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('target').textContent).toBe('false|true'),
    )

    await act(async () => {
      first.resolve()
      second.resolve()
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Second Title' }))
  })



  /**
   * A selector is user code, and the frame path runs it outside React's
   * render — from the Router's `startTransition`, to decide whether a
   * consumer's selection changed. A throw there reaches no error boundary and
   * unwinds into the navigation that sent the notification.
   */
  test('a throwing selector surfaces in render rather than wedging the navigation', async () => {
    const errors: Array<string> = []

    class Boundary extends React.Component<
      { children: React.ReactNode },
      { failed: boolean }
    > {
      state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error: Error) {
        errors.push(error.message)
      }
      render() {
        return this.state.failed ? (
          <div data-testid="caught">caught</div>
        ) : (
          this.props.children
        )
      }
    }

    function Boom() {
      const pathname = useRouterState({
        select: (state) => {
          if (state.location.pathname === '/posts') {
            throw new Error('selector boom')
          }
          return state.location.pathname
        },
      })
      return <div data-testid="pathname">{pathname}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Boundary>
            <Boom />
          </Boundary>
          <Outlet />
        </>
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      component: () => <h1>Posts Title</h1>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, postsRoute]),
      experimental_concurrentRenderFrames: true,
    })

    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/posts' })
    })

    // The navigation completes, and the throw lands where a throwing selector
    // lands on the store path: in the nearest error boundary.
    await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))
    await navigation
    expect(router.stores.status.get()).toBe('idle')
    await waitFor(() => screen.getByTestId('caught'))
    expect(errors).toContain('selector boom')
  })
})
