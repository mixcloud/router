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
  Link,
  Matches,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useRouterState,
} from '../src'

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
})
