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
  useFrameMode,
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
  useCanGoBack,
  useLocation,
  useMatchRoute,
  useNavigate,
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

  /**
   * What each path shows while the next route loads.
   *
   * On the frame path suspension consolidates at one boundary around the route
   * tree. That boundary mounts with the tree, so the first render shows its
   * fallback — built from the root route, which is why a route's own
   * `pendingComponent` is not the one that appears. By the time a navigation
   * happens the boundary is already mounted, and the navigation is a
   * transition: React keeps the route on screen rather than replacing it with
   * a fallback. So no pending UI appears on a navigation at all, and
   * `pendingMs` / `pendingMinMs` have nothing to time.
   *
   * That is the behaviour the option exists to produce, not a defect, but it
   * is a behaviour change large enough to pin against the store path rather
   * than leave to be rediscovered. Progress UI is expected to read `status`
   * and `isLoading`, which stay live on both paths.
   */
  test('what stands in for the loading route differs by path', async () => {
    const gate = deferred()

    const makePendingRouter = (initialPath: string) => {
      const rootRoute = createRootRoute({
        pendingComponent: () => <h1>Root Pending</h1>,
        component: () => (
          <>
            <Link to="/slow">Slow</Link>
            <Outlet />
          </>
        ),
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
        pendingMs: 0,
        pendingComponent: () => <h1>Route Pending</h1>,
        component: () => <h1>Slow Title</h1>,
      })
      return createRouter({
        routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
        experimental_concurrentRenderFrames,
        history: createMemoryHistory({ initialEntries: [initialPath] }),
      })
    }

    // First render: the boundary mounts with the tree, so a fallback shows on
    // both paths — the root route's on the frame path, the route's own on the
    // store path.
    render(<RouterProvider router={makePendingRouter('/slow')} />)
    await waitFor(() =>
      screen.getByRole('heading', {
        name: experimental_concurrentRenderFrames
          ? 'Root Pending'
          : 'Route Pending',
      }),
    )
    cleanup()

    // A navigation, with the boundary already mounted.
    const router = makePendingRouter('/')
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    fireEvent.click(screen.getByRole('link', { name: 'Slow' }))
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))

    if (experimental_concurrentRenderFrames) {
      // The route being left stays on screen instead of any fallback.
      expect(screen.queryByRole('heading', { name: 'Route Pending' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Root Pending' })).toBeNull()
      expect(
        screen.getByRole('heading', { name: 'Index Title' }),
      ).toBeInTheDocument()
    } else {
      await waitFor(() => screen.getByRole('heading', { name: 'Route Pending' }))
    }

    gate.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
  })

  /**
   * A provider can unmount while a navigation is loading and mount again on
   * the same router. The frame path caches an owner per router, so the second
   * tree inherits the first one's in-flight frame — which the first tree was
   * going to acknowledge and never did.
   *
   * A fresh consumer seeds from `staged ?? committed`, so that tree renders
   * the staged frame; acknowledging against the committed one instead left
   * the owner gated on `pending` for good and the router `pending` with it,
   * so progress UI stayed on until something else navigated. Asserting both
   * paths pins the frame path back to what the store path does.
   *
   * The interrupted navigation's own promise never settles on either path —
   * nothing is left to render it — which is why this asserts on the router's
   * status rather than awaiting it.
   */
  test('a provider remounted mid-navigation settles', async () => {
    const gate = deferred()

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Link to="/slow">Slow</Link>
          <Outlet />
        </>
      ),
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
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    const navigation = router.navigate({ to: '/slow' })
    navigation.catch(() => {})
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))

    // The tree goes away mid-navigation, and the load finishes with nothing
    // left to render it — that is what leaves the frame in flight.
    cleanup()
    gate.resolve()
    await act(async () => {
      await gate.promise
    })

    // Then it comes back on the same router.
    render(<RouterProvider router={router} />)

    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
    await waitFor(() => expect(router.stores.status.get()).toBe('idle'))
  })

  /**
   * `useCanGoBack` is an exception to the rule the rest of the adapter
   * follows, and this pins it. `history.back()` acts on the browser's
   * history, not on the frame on screen, so the answer has to describe the
   * history the button would actually move.
   *
   * Reading the presented frame instead disagrees with it for exactly the
   * staged window: a push from index 0 leaves the presented frame at 0 and
   * the control disabled while the entry is already there to pop — and the
   * dangerous direction, a pending pop to index 0, leaves it at 1, where a
   * back control fires a second pop and leaves the application.
   */
  test('canGoBack follows the browser history, not the presented frame', async () => {
    const gate = deferred()
    const seen: Array<boolean> = []

    function BackProbe() {
      const canGoBack = useCanGoBack()
      seen.push(canGoBack)
      return <div data-testid="back">{String(canGoBack)}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <BackProbe />
          <Outlet />
        </>
      ),
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
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    // Index 0: nothing to go back to.
    expect(screen.getByTestId('back')).toHaveTextContent('false')

    const navigation = router.navigate({ to: '/slow' })
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    // The entry exists and can be popped, while `/` is still on screen.
    expect(
      screen.getByRole('heading', { name: 'Index Title' }),
    ).toBeInTheDocument()
    expect(router.stores.location.get().state.__TSR_index).toBe(1)
    await waitFor(() =>
      expect(screen.getByTestId('back')).toHaveTextContent('true'),
    )

    gate.resolve()
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
    expect(screen.getByTestId('back')).toHaveTextContent('true')
    expect(seen).toContain(true)
  })

  /**
   * A same-location refresh is not a supersession, and the frame path presents
   * exactly what the store path does.
   *
   * `isSuperseded` compares the location and the history entry, so two
   * overlapping `invalidate()` calls for the same entry look identical to it —
   * raised in review as a case where a suspended refresh frame could commit
   * behind a successor that is still loading. It can, and that is the same
   * content the store path shows at the same moment: the first refresh's data
   * is the freshest that exists, the successor has produced nothing yet, and
   * refusing the frame would put back content older than what has already been
   * rendered. Asserted on both paths so the parity is the contract rather than
   * an observation.
   */
  test('overlapping refreshes of one location present the same sequence as the store path', async () => {
    const firstRefresh = deferred<string>()
    const secondRefresh = deferred<string>()
    const resume = deferred()
    let generation = 0
    let resumed = false
    resume.promise.then(() => {
      resumed = true
    })
    const presented: Array<string> = []

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      loader: () => {
        const load = generation++
        return load === 0
          ? '1'
          : load === 1
            ? firstRefresh.promise
            : secondRefresh.promise
      },
      component: function IndexComponent() {
        const data = indexRoute.useLoaderData()
        // The first refresh's tree suspends, so its frame is staged and
        // rendered but cannot be acknowledged until `resume` resolves.
        if (data === '2' && !resumed) {
          throw resume.promise
        }
        presented.push(data)
        return <div data-testid="data">{data}</div>
      },
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })

    render(<RouterProvider router={router} />)
    await waitFor(() =>
      expect(screen.getByTestId('data')).toHaveTextContent('1'),
    )

    // The first refresh's data arrives; its tree suspends on it.
    const first = router.invalidate()
    first.catch(() => {})
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    firstRefresh.resolve('2')
    await act(async () => {
      await firstRefresh.promise
    })
    expect(screen.getByTestId('data')).toHaveTextContent('1')

    // A second refresh of the same entry starts, and is still loading when
    // the suspended tree resumes.
    const second = router.invalidate()
    second.catch(() => {})
    await act(async () => {
      await Promise.resolve()
    })
    resume.resolve()
    await act(async () => {
      await resume.promise
    })
    expect(screen.getByTestId('data')).toHaveTextContent('2')

    secondRefresh.resolve('3')
    await act(async () => {
      await secondRefresh.promise
    })
    await waitFor(() =>
      expect(screen.getByTestId('data')).toHaveTextContent('3'),
    )

    // Never backwards, and never a generation skipped.
    expect(presented).toEqual(['1', '2', '3'])
  })

  /**
   * A publication that is re-entered stages nothing.
   *
   * A frame is assembled from the aggregate store *after* the publication
   * callback returns, and that callback ends by emitting `onLoad` and
   * `onBeforeRouteMount` — user code, which may navigate. It does so
   * synchronously: the location moves to the successor while the matches this
   * publication just committed are still in the store, so the aggregate read
   * afterwards pairs one route's matches with another route's URL. Nothing
   * downstream can reject that frame either, because `isSuperseded` compares
   * its location against the head and the head is exactly where the successor
   * put it.
   *
   * The store path shows that pair too — it reads the live atoms, so it is
   * transiently inconsistent by construction, and that is upstream behaviour
   * this option does not change. What the frame path must not do is *commit*
   * it, because a frame is supposed to be a snapshot of one publication and
   * this one is a snapshot of no publication at all. Both arms are asserted so
   * the difference is the contract.
   */
  test('a publication re-entered by a navigation stages no frame', async () => {
    const slow = deferred()
    const presented: Array<string> = []

    function Probe() {
      const value = useRouterState({
        select: (s) =>
          `${s.location.pathname}|${s.matches.map((m) => m.routeId).join('+')}`,
      })
      presented.push(value)
      return <div data-testid="probe">{value}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Probe />
          <Outlet />
        </>
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const aRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/a',
      component: () => <h1>A Title</h1>,
    })
    const bRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/b',
      loader: () => slow.promise,
      component: () => <h1>B Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, aRoute, bRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })

    // The listener that re-enters, exactly where `load-client` emits it.
    let navigated = false
    router.subscribe('onLoad', (event) => {
      if (navigated || event.toLocation.pathname !== '/a') {
        return
      }
      navigated = true
      const successor = router.navigate({ to: '/b' })
      successor.catch(() => {})
    })

    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    presented.length = 0

    const toA = router.navigate({ to: '/a' })
    toA.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The head is at `/b` on both paths, with `/b` still loading.
    expect(router.stores.location.get().pathname).toBe('/b')

    if (experimental_concurrentRenderFrames) {
      // A coherent publication — the one still on screen — rather than the
      // successor's URL wearing the previous route's matches.
      expect(screen.getByTestId('probe')).toHaveTextContent('/|__root__+/')
      expect(presented).not.toContain('/b|__root__+/a')
    } else {
      // Upstream behaviour, asserted so the difference is deliberate.
      expect(screen.getByTestId('probe')).toHaveTextContent('/b|__root__+/a')
    }

    // Both converge once the successor's load resolves.
    slow.resolve()
    await act(async () => {
      await slow.promise
    })
    await waitFor(() => screen.getByRole('heading', { name: 'B Title' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('/b|__root__+/b')
  })

  /**
   * Progress reaches consumers even when route content does not move.
   *
   * `frameId` identifies route content and deliberately excludes `status` and
   * `isLoading`, so a progress-only publication carries the id the frame path
   * has already committed. That is not a no-op: a frame committed during a
   * navigation takes its progress from the head, and the head is still
   * 'pending' there, because the load settles only after the acknowledgement
   * it is awaiting. The idle that follows is the notification that says the
   * load has finished.
   *
   * Driven through the store rather than a navigation: every load today pairs
   * its status change with a location change, so the id advances and hides
   * the question. The frame path must not depend on that pairing — nothing in
   * the store's contract promises it — and the store path, which reads the
   * live atoms, never could.
   */
  test('a progress-only publication reaches consumers', async () => {
    const rootRoute = createRootRoute({
      component: function RootComponent() {
        const progress = useRouterState({
          select: (s) => `${s.status}|${String(s.isLoading)}`,
        })
        return (
          <>
            <div data-testid="progress">{progress}</div>
            <Outlet />
          </>
        )
      },
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index</h1>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames,
    })

    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index' }))
    expect(screen.getByTestId('progress')).toHaveTextContent('idle|false')

    act(() => {
      router.stores.status.set('pending')
    })
    expect(screen.getByTestId('progress')).toHaveTextContent('pending|true')

    act(() => {
      router.stores.status.set('idle')
    })
    expect(screen.getByTestId('progress')).toHaveTextContent('idle|false')
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

  /**
   * The other half of adopting an in-flight frame, for a router this tree
   * returns to rather than mounts on. `Matches` survives the prop change, so
   * the state initializer does not run again; the queue is pruned to whatever
   * router is current, so coming back to one whose owner still holds a staged
   * frame left it with nothing queued. Its acknowledgement compared against
   * the committed frame and never settled, so that router stayed `pending`.
   *
   * Asserted on the router's status: swapping the router under a mounted
   * provider does not render the replacement's route tree upstream either, so
   * there is no DOM to compare.
   */
  test('a router returned to adopts the frame still in flight', async () => {
    const gate = deferred()

    const makeSwapRouter = (slow: boolean) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> })
      const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <h1>Index Title</h1>,
      })
      const slowRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/slow',
        loader: slow ? () => gate.promise : undefined,
        component: () => <h1>Slow Title</h1>,
      })
      return createRouter({
        routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
        defaultPendingMs: 0,
        experimental_concurrentRenderFrames: true,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      })
    }

    const first = makeSwapRouter(false)
    const second = makeSwapRouter(true)
    const tree = (router: AnyRouter) => (
      <RouterContextProvider router={router}>
        <Matches />
      </RouterContextProvider>
    )

    const { rerender } = render(tree(first))
    await waitFor(() => expect(first.stores.status.get()).toBe('idle'))

    // Onto the second router, with a navigation that cannot finish yet.
    rerender(tree(second))
    const navigation = second.navigate({ to: '/slow' })
    navigation.catch(() => {})
    await waitFor(() => expect(second.stores.status.get()).toBe('pending'))

    // Away — which prunes the queue to the other router — and back, with the
    // load finished in between so nothing new is staged on the return.
    rerender(tree(first))
    gate.resolve()
    await act(async () => {
      await gate.promise
    })
    rerender(tree(second))

    await waitFor(() => expect(second.stores.status.get()).toBe('idle'))
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
   * The other half of the same hazard, with the provider's router changing
   * instead of the reader's argument. A mounted provider handed a router
   * configured the other way installs an owner whose frame mode disagrees
   * with the one the tree mounted on, and a reader that took the tree's
   * answer per render would change hook shape underneath itself. The mounted
   * path has to survive the swap even though the mode it names is no longer
   * the one the current router asks for.
   */
  test('a provider handed a router configured the other way keeps the mounted path', async () => {
    const framed = makeRouter()
    // Frames off, and somewhere else, so the assertion says which router was
    // read as well as that the swap did not crash.
    const plain = makeRouter(false, '/posts')

    function Probe() {
      const pathname = useRouterState({
        select: (state) => state.location.pathname,
      })
      return <div data-testid="pathname">{pathname}</div>
    }

    const { rerender } = render(
      <RouterContextProvider router={framed}>
        <Probe />
      </RouterContextProvider>,
    )
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')

    // Crosses the option itself: the reader mounted on the frame path and the
    // new owner's mode is false.
    rerender(
      <RouterContextProvider router={plain}>
        <Probe />
      </RouterContextProvider>,
    )
    expect(screen.getByTestId('pathname')).toHaveTextContent('/posts')

    // And back, so neither direction of the swap decides hook order.
    rerender(
      <RouterContextProvider router={framed}>
        <Probe />
      </RouterContextProvider>,
    )
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
            // Cast: a functional `state` updater is typed to return a full
            // `HistoryState`, and this one deliberately returns only the field
            // the assertion reads.
            state={((prev: any) => ({ from: prev.__TSR_index })) as any}
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
   * The same cache, mutated by the render rather than by the probe. A consumer
   * that sits *above* the changing route renders in the staged tree too, so
   * its selector runs against the staged publication — and if that render is
   * discarded because something below it suspends, the cache is left
   * describing a selection nobody ever saw.
   */
  test('a discarded staged render does not disturb a structural-sharing selection', async () => {
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

    // Recorded from an effect, so only renders that *committed* count. A
    // render-phase push would also record the staged render this test is
    // arranging to have discarded, which is not what is on screen.
    const committedSelections: Array<{ pathname: string }> = []

    // In the root component, so it renders in the staged tree as well as the
    // visible one — unlike a consumer inside the route being replaced.
    function Shell() {
      const [bumps, setBumps] = React.useState(0)
      const selected = useRouterState({
        structuralSharing: true,
        select: (state) => ({ pathname: state.location.pathname }),
      })
      React.useEffect(() => {
        committedSelections.push(selected)
      }, [selected])
      return (
        <>
          <button type="button" onClick={() => setBumps((n) => n + 1)}>
            Bump
          </button>
          <div data-testid="shell">{`${selected.pathname}|${bumps}`}</div>
          <Outlet />
        </>
      )
    }

    const rootRoute = createRootRoute({ component: Shell })
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
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    const onScreen = committedSelections.at(-1)!

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/next' })
    })
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/next'),
    )
    // The staged tree is suspended below the shell, so nothing it rendered has
    // committed.
    expect(screen.getByRole('heading', { name: 'Index Title' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Bump' }))
    expect(screen.getByTestId('shell').textContent).toBe('/|1')
    expect(committedSelections.at(-1)).toBe(onScreen)

    await act(async () => {
      releaseNext()
      await nextGate
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Next Title' }))
  })


  /**
   * The same question as a link's click, asked imperatively: a handler on the
   * route the user is looking at must resolve against that route, not the one
   * the router is preparing.
   */
  test('an imperative navigation resolves against the visible route', async () => {
    const gate = deferred()
    let loads = 0

    function Controls() {
      const navigate = useNavigate()
      return (
        <button
          type="button"
          onClick={() => {
            void navigate({
              to: '/posts',
              search: (prev: any) => ({ page: (prev.page ?? 1) + 1 }),
            })
          }}
        >
          Next page
        </button>
      )
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Controls />
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
      loaderDeps: ({ search }: { search: { page: number } }) => ({
        page: search.page,
      }),
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

    // Head moves to page 5 and stays pending, so the visible route and the
    // head disagree about what "the next page" is.
    act(() => {
      void router.navigate({ to: '/posts', search: { page: 5 } })
    })
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    screen.getByRole('heading', { name: 'Posts 1' })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    })
    gate.resolve()

    await waitFor(() => screen.getByRole('heading', { name: 'Posts 2' }))
    expect(router.stores.location.get().search).toEqual({ page: 2 })
  })


  /**
   * The limit of resolving an imperative navigation from the visible route,
   * pinned rather than left to be discovered.
   *
   * React runs layout effects bottom-up, and `MatchesInner` commits the frame
   * from a layout effect of its own — an ancestor's. So a destination
   * component calling `navigate` from its *mount* layout effect runs before
   * the frame it rendered from has committed, and resolves against the route
   * being left: it renders page 5 and navigates to page 2.
   *
   * Which is right depends on where the caller is, and nothing available
   * outside render says: the same getter that gets this case wrong is what
   * gets a handler on the visible route right, and that is the common case. It
   * needs the per-tree frame identity that mount-time isolation needs, and is
   * documented with it. This test exists so the trade cannot change silently.
   */
  test('an imperative navigation from a mount effect resolves against the route being left', async () => {
    let redirected = false
    const rendered: Array<number> = []

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      validateSearch: (search: Record<string, unknown>) => ({
        page: Number(search.page ?? 1),
      }),
      component: function Posts() {
        const page = postsRoute.useSearch({ select: (s) => s.page })
        const navigate = useNavigate()
        rendered.push(page)
        React.useLayoutEffect(() => {
          if (page === 5 && !redirected) {
            redirected = true
            void navigate({
              to: '/posts',
              search: (prev: any) => ({ page: (prev.page ?? 1) + 1 }),
            })
          }
        }, [page, navigate])
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

    act(() => {
      void router.navigate({ to: '/posts', search: { page: 5 } })
    })
    await waitFor(() => expect(redirected).toBe(true))
    await waitFor(() => expect(router.stores.status.get()).toBe('idle'))

    // Rendered page 5, resolved from page 1. Documented, not desired.
    expect(rendered).toContain(5)
    expect(router.stores.location.get().search).toEqual({ page: 2 })
  })


  /**
   * `InnerWrap` wraps the whole match tree — the `Transitioner` and the root
   * Suspense boundary included — so it is *outside* the route tree, and reads
   * the committed publication like any other outside reader. That is
   * deliberate: the visible surroundings must not jump to the destination
   * while the route on screen is still the old one, which is what lets
   * `<ViewTransition>` pair an old and a new element at all.
   *
   * The cost, worth naming: something inside `InnerWrap` that suspends until
   * the wrapper describes the destination would wait for a commit that its own
   * suspension prevents. That is a property of the committed scope rather than
   * of `InnerWrap`, and it applies to any consumer outside the route tree.
   */
  test('InnerWrap reads the committed route while a navigation is staged', async () => {
    const gate = deferred()

    function Wrap({ children }: { children: React.ReactNode }) {
      const pathname = useRouterState({ select: (s) => s.location.pathname })
      return (
        <>
          <div data-testid="wrap">{pathname}</div>
          {children}
        </>
      )
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      loader: () => gate.promise,
      component: () => <h1>Next Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
      experimental_concurrentRenderFrames: true,
      InnerWrap: Wrap,
    })

    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('wrap').textContent).toBe('/')

    let navigation!: Promise<void>
    act(() => {
      navigation = router.navigate({ to: '/next' })
    })
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))

    // The head is at /next; the wrapper is still describing what is on screen.
    expect(router.stores.location.get().pathname).toBe('/next')
    expect(screen.getByTestId('wrap').textContent).toBe('/')

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    await navigation
    await waitFor(() => screen.getByRole('heading', { name: 'Next Title' }))
    // And once it commits, it follows.
    await waitFor(() =>
      expect(screen.getByTestId('wrap').textContent).toBe('/next'),
    )
  })


  /**
   * The option is mutable: `RouterContextProvider` forwards prop updates
   * through `router.update`. So freezing the decision per component is not
   * enough — a component mounting after the option changed would freeze the
   * new answer while the tree around it still stages and acknowledges frames,
   * and its subscription would read the head synchronously inside a route
   * that is still presenting the committed publication.
   */
  test('a reader mounted after the option changed follows the provider', async () => {
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
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // Turn the option off underneath the mounted tree, which keeps staging
    // frames because its owner was built with it on.
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: false,
      })
    })

    fireEvent.click(screen.getByRole('link', { name: 'Slow' }))
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    expect(router.stores.location.get().pathname).toBe('/slow')

    act(() => showLateConsumer(true))

    // Follows the provider, not the option as it now reads: the route on
    // screen is still `/`.
    expect(screen.getByTestId('late').textContent).toBe('/')

    gate.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
  })

  /**
   * The store path publishes its decision too. Only the frame path builds an
   * owner, so when the tree's answer was carried on the owner there was
   * nothing to read on the other arm: a reader mounting after the option was
   * turned *on* under a store-path tree froze `true` from the option and took
   * the frame path while `Matches` and the `Transitioner` around it stayed on
   * the store path.
   *
   * Harmless in what it reads — with no owner it resolves to the router's
   * head, which is what the store path reads anyway — but the tree should
   * have one answer, and this is the same invariant as the arm above.
   */
  test('a reader mounted after the option was turned on follows the store-path tree', async () => {
    const modes: Array<boolean> = []

    function ModeProbe() {
      modes.push(useFrameMode(router))
      return null
    }

    let showProbe!: (show: boolean) => void
    const rootRoute = createRootRoute({
      component: function RootComponent() {
        const [show, setShow] = React.useState(false)
        showProbe = setShow
        return (
          <>
            {show ? <ModeProbe /> : null}
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

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      experimental_concurrentRenderFrames: false,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // Turned on underneath the mounted tree, which stays on the store path.
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
      })
    })
    act(() => showProbe(true))

    expect(modes).toEqual([false])
  })

  /**
   * A fresh provider mount reads the option as it stands, not as it stood the
   * last time this router was mounted. Owners are cached per router for the
   * router's lifetime, so seeding the tree's decision from the owner meant a
   * router first mounted with the option off could never be mounted with it
   * on again — the second tree would silently stay on the store path.
   */
  test('a fresh provider mount reads the option as it now stands', async () => {
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
      defaultPendingMs: 0,
      // Off, so nothing here builds an owner on its own.
      experimental_concurrentRenderFrames: false,
    })

    // An owner is only ever built on the frame path — so build one for this
    // router the way a swap does, under a provider that is already on it.
    // That is what caches `frameMode: false` against this router for good.
    const framed = createRouter({
      routeTree: createRootRoute({ component: () => null }).addChildren([]),
      experimental_concurrentRenderFrames: true,
    })
    const { rerender } = render(
      <RouterContextProvider router={framed}>
        <div />
      </RouterContextProvider>,
    )
    rerender(
      <RouterContextProvider router={router}>
        <div />
      </RouterContextProvider>,
    )
    cleanup()

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
      })
    })

    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    fireEvent.click(screen.getByRole('link', { name: 'Slow' }))
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    expect(router.stores.location.get().pathname).toBe('/slow')

    act(() => showLateConsumer(true))

    // On the frame path, which is what the option now asks for.
    expect(screen.getByTestId('late').textContent).toBe('/')

    gate.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
  })

  /**
   * And the same for a reader that mounts after the provider was handed a
   * router configured the other way. The tree keeps the frame path it mounted
   * with, so it goes on staging frames through the replacement router's
   * scopes; a reader seeded from that owner's own mode would subscribe to the
   * head instead and read the route being prepared.
   *
   * The reader sits outside the route tree on purpose. The root scope only
   * advances when a navigation commits, so what it presents is unambiguous —
   * and the replacement's route tree does not render at all (see the swap
   * test above), so there is nowhere inside it to mount one.
   */
  test('a reader mounted after a router swap follows the provider', async () => {
    const gate = deferred()
    let showLateConsumer!: (show: boolean) => void

    function LateConsumer() {
      const pathname = useLocation({ select: (l) => l.pathname })
      return <div data-testid="late">{pathname}</div>
    }

    function Harness() {
      const [show, setShow] = React.useState(false)
      showLateConsumer = setShow
      return show ? <LateConsumer /> : null
    }

    const makeSwapRouter = (frames: boolean) => {
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
      return createRouter({
        routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
        defaultPendingMs: 0,
        experimental_concurrentRenderFrames: frames,
      })
    }

    const framed = makeSwapRouter(true)
    const plain = makeSwapRouter(false)

    const { rerender } = render(
      <RouterContextProvider router={framed}>
        <Harness />
        <Matches />
      </RouterContextProvider>,
    )
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // The tree stays on the frame path; the owner it now reads through was
    // built with the option off.
    rerender(
      <RouterContextProvider router={plain}>
        <Harness />
        <Matches />
      </RouterContextProvider>,
    )

    const navigation = plain.navigate({ to: '/slow' })
    await waitFor(() => expect(plain.stores.status.get()).toBe('pending'))
    expect(plain.stores.location.get().pathname).toBe('/slow')

    // Mounted urgently, during that navigation.
    act(() => showLateConsumer(true))

    // The committed publication, not the head.
    expect(screen.getByTestId('late').textContent).toBe('/')

    gate.resolve()
    await navigation.catch(() => {})
  })

  /**
   * A staged frame is offered to a tree that may be suspended, and a
   * replacement navigation moves the head without publishing anything of its
   * own until its load resolves. The first tree could finish suspending
   * inside that window and commit a destination the URL had already left —
   * the acknowledgement matched on frame identity alone, and that identity
   * was still the one the owner was holding.
   */
  test('a superseded frame does not commit while its tree is suspended', async () => {
    const suspense = deferred()
    const slowLoader = deferred()
    let thrown = false

    function SuspendsOnce() {
      if (!thrown) {
        thrown = true
        throw suspense.promise
      }
      return <h1>First Title</h1>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const firstRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/first',
      component: () => <SuspendsOnce />,
    })
    const secondRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/second',
      loader: () => slowLoader.promise,
      component: () => <h1>Second Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, firstRoute, secondRoute]),
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // Stages a frame whose tree suspends, so nothing commits it.
    const first = router.navigate({ to: '/first' })
    first.catch(() => {})
    await act(async () => {
      await Promise.resolve()
    })

    // The replacement moves the head. Its loader is slow and it has no
    // pending component, so it publishes nothing for a while.
    const second = router.navigate({ to: '/second' })
    second.catch(() => {})
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/second'),
    )

    // The first tree finishes suspending inside that window.
    suspense.resolve()
    await act(async () => {
      await suspense.promise
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The route the URL left must not be on screen.
    expect(screen.queryByRole('heading', { name: 'First Title' })).toBeNull()

    slowLoader.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Second Title' }))
  })

  /**
   * Adoption has to apply the same supersession test as the owner does.
   *
   * Cancelling a superseded frame happens from the store subscription a
   * provider holds — so while no provider is mounted, nothing notices the
   * head moving. A tree mounting afterwards adopted whatever was staged, and
   * because a descendant's layout effect runs before the provider's own, it
   * acknowledged and committed that frame before anything could drop it: the
   * route the head had left, back on screen.
   */
  test('a tree does not adopt a frame the head has left', async () => {
    const first = deferred()
    const second = deferred()

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
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
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    // The first navigation is in flight when the tree goes away, and its load
    // finishes with nothing left to render it — so the owner holds it staged.
    const toFirst = router.navigate({ to: '/first' })
    toFirst.catch(() => {})
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    cleanup()
    first.resolve()
    await act(async () => {
      await first.promise
    })

    // The head moves on while there is no provider to notice.
    const toSecond = router.navigate({ to: '/second' })
    toSecond.catch(() => {})
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/second'),
    )

    // And a tree mounts before the successor stages anything.
    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole('heading', { name: 'First Title' })).toBeNull()

    second.resolve()
    await waitFor(() => screen.getByRole('heading', { name: 'Second Title' }))
  })

  /**
   * Rejecting a stale frame for adoption is not enough: it is still in the
   * staged slot, and that slot is what seeds a fresh reader. `MatchesInner`'s
   * own matches reader is one, so the route the stale frame names still
   * mounted and ran its effects — descendant effects run before the
   * provider's, so a `<Navigate>` in that route would fire a redirect from a
   * frame nothing ever acknowledged. The frame is refused at the seeding
   * point too.
   */
  test('a rejected staged frame does not mount its route', async () => {
    const first = deferred()
    const second = deferred()
    const mounted: Array<string> = []

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const firstRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/first',
      loader: () => first.promise,
      component: function FirstComponent() {
        React.useEffect(() => {
          mounted.push('first')
        }, [])
        return <h1>First Title</h1>
      },
    })
    const secondRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/second',
      loader: () => second.promise,
      component: () => <h1>Second Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, firstRoute, secondRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })
    render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))

    const toFirst = router.navigate({ to: '/first' })
    toFirst.catch(() => {})
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    cleanup()
    first.resolve()
    await act(async () => {
      await first.promise
    })

    const toSecond = router.navigate({ to: '/second' })
    toSecond.catch(() => {})
    await waitFor(() =>
      expect(router.stores.location.get().pathname).toBe('/second'),
    )

    mounted.length = 0
    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The stale route must not have mounted at all.
    expect(mounted).toEqual([])

    second.resolve()
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

  /**
   * The acknowledgement boundary revalidates the head.
   *
   * `commit` matches the frame it is handed against `pending` by identity,
   * and the frame satisfies that — it really is the one that was staged.
   * What identity cannot say is whether the head is still there. Withdrawing
   * a superseded frame runs from the store subscription the provider installs
   * in a layout effect, and layout effects run bottom-up, so a tree that
   * adopted the frame during a render React then yielded out of reaches this
   * boundary before that subscription exists: a navigation starting inside
   * the gap moves the head with nothing watching.
   *
   * That interleaving needs a real concurrent yield, which `act` does not
   * produce. The state it leaves behind is what matters and is exact — a
   * pending frame the head has left, and no publication in between for a
   * subscription to have noticed — so the boundary is driven directly.
   */
  test('an acknowledgement for a frame the head has left is refused', async () => {
    let owner!: NonNullable<ReturnType<typeof useRouterStateOwner>>

    const rootRoute = createRootRoute({
      component: function RootComponent() {
        owner = useRouterStateOwner()!
        return <Outlet />
      },
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

    // A genuine frame, for a location the head then leaves.
    let toPosts!: Promise<void>
    act(() => {
      toPosts = router.navigate({ to: '/posts' })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))
    await toPosts
    const postsFrame = owner.frame
    let toIndex!: Promise<void>
    act(() => {
      toIndex = router.navigate({ to: '/' })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    await toIndex

    // Staged without moving the store, which is the gap: nothing publishes,
    // so nothing withdraws it.
    act(() => {
      owner.begin()
      owner.stage(postsFrame)
    })

    let accepted: boolean | undefined
    act(() => {
      accepted = owner.commit(postsFrame)
    })

    expect(accepted).toBe(false)
    expect(owner.frame.location.pathname).toBe('/')
    // And the refusal withdraws it rather than leaving it on offer, so the
    // route subtree falls back to the route that is still on screen.
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.queryByRole('heading', { name: 'Posts Title' })).toBeNull()
  })

  /**
   * A fresh owner is seeded from a coherent publication.
   *
   * An owner can be built while a navigation is already in flight: a router
   * that committed its matches on the store path, then had the option turned
   * on, then started navigating before a provider mounted. The head at that
   * moment is not a snapshot of one publication — `location` is the
   * destination while `matches` are still the ones on screen — so seeding both
   * scopes from it presents the successor's URL beside the previous route's
   * content for the whole load.
   *
   * The store path shows that pair too, so this is not about beating it. It is
   * about the frame path agreeing with itself: a tree that stays mounted
   * through a navigation presents the route and URL it is showing until the
   * navigation commits, and mounting midway should not differ. `resolvedLocation`
   * is the location the committed matches were resolved for, which pairs them
   * back up.
   */
  test('an owner built mid-navigation seeds a coherent publication', async () => {
    const gate = deferred()

    function Probe() {
      const value = useRouterState({
        select: (s) =>
          `${s.location.pathname}|${s.matches.map((m) => m.routeId).join('+')}`,
      })
      return <div data-testid="probe">{value}</div>
    }

    const rootRoute = createRootRoute({
      component: () => (
        <>
          <Probe />
          <Outlet />
        </>
      ),
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
      defaultPendingMs: 0,
      // The store path commits matches without ever building an owner, which
      // is what leaves a later mount to build a fresh one.
      experimental_concurrentRenderFrames: false,
    })

    const first = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    first.unmount()

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
      })
    })

    // In flight with nothing mounted, so the next provider builds the owner.
    const navigation = router.navigate({ to: '/slow' })
    navigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(router.stores.location.get().pathname).toBe('/slow')
    expect(router.stores.matches.get().map((m) => m.routeId)).toEqual([
      '__root__',
      '/',
    ])

    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The route on screen and the URL it belongs to, not a mixture.
    expect(screen.getByTestId('probe')).toHaveTextContent('/|__root__+/')

    gate.resolve()
    await act(async () => {
      await gate.promise
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Slow Title' }))
    expect(screen.getByTestId('probe')).toHaveTextContent('/slow|__root__+/slow')
  })

  /**
   * A cached owner is brought back in step before a tree reads it.
   *
   * Owners are cached for the router's lifetime, which outlasts any one tree,
   * and only a mounted frame-path provider keeps one in step — its layout
   * effect installs the store subscription that drives `publish`. So a router
   * that is mounted on the *store* path in between, and navigates there,
   * leaves its cached owner a whole route behind. The next frame-path mount
   * then renders that stale route and runs its effects before the provider's
   * own effect can publish, which is how a `<Navigate>` in the route the user
   * has left would fire.
   *
   * Asserted on mount effects rather than on screen, for the reason the
   * rejected-seed test records: the correction lands before paint, so the
   * screen looks right while the wrong route has already mounted. The control
   * is the store path, where no owner exists and only the current route
   * mounts.
   */
  test('a cached owner stale from a store-path interlude does not mount its route', async () => {
    const mounted: Array<string> = []

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: function IndexComponent() {
        React.useEffect(() => {
          mounted.push('index')
        }, [])
        return <h1>Index Title</h1>
      },
    })
    const postsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/posts',
      component: function PostsComponent() {
        React.useEffect(() => {
          mounted.push('posts')
        }, [])
        return <h1>Posts Title</h1>
      },
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, postsRoute]),
      experimental_concurrentRenderFrames: true,
    })

    // A frame-path mount builds and caches the owner, committed at `/`.
    const framed = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    framed.unmount()

    // A store-path mount navigates with nothing driving that owner.
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: false,
      })
    })
    const stored = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    await act(async () => {
      await router.navigate({ to: '/posts' })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))
    stored.unmount()
    expect(router.stores.location.get().pathname).toBe('/posts')

    // Back on the frame path, onto the cached owner.
    mounted.length = 0
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
      })
    })
    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The route the router is actually on, and only that one.
    expect(mounted).toEqual(['posts'])
    await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))
  })

  /**
   * The same, where only the search changed.
   *
   * `/items?page=1` to `/items?page=2` publishes a pending lane whose matches
   * have the *same pathname* as the committed ones, so nothing about the
   * route path distinguishes them — an earlier revision of the seed compared
   * exactly that and could not tell them apart, pairing page 2's matches with
   * page 1's URL. Taking the committed publication needs no such comparison.
   */
  test('an owner seeded during a search-only pending navigation takes the committed publication', async () => {
    const gate = deferred()
    let seeded: string | undefined

    function CaptureOwner({ children }: { children?: React.ReactNode }) {
      const owner = useRouterStateOwner()
      if (owner && seeded === undefined) {
        const page = (owner.frame.matches.at(-1)?.search as { page?: number })
          .page
        seeded = `${owner.frame.location.searchStr}|page=${page}`
      }
      return <>{children}</>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const itemsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/items',
      validateSearch: (search: Record<string, unknown>) => ({
        page: Number(search.page ?? 1),
      }),
      loaderDeps: ({ search }) => ({ page: search.page }),
      loader: ({ deps }) => (deps.page === 1 ? 'first' : gate.promise),
      pendingComponent: () => <h1>Items Pending</h1>,
      component: () => <h1>Items Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([itemsRoute]),
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      experimental_concurrentRenderFrames: false,
    })

    const first = render(<RouterProvider router={router} />)
    await act(async () => {
      await router.navigate({ to: '/items', search: { page: 1 } })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'Items Title' }))
    first.unmount()

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
        InnerWrap: CaptureOwner,
      })
    })

    const navigation = router.navigate({ to: '/items', search: { page: 2 } })
    navigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Same pathname on both sides, so only the search tells them apart.
    expect(router.stores.location.get().searchStr).toBe('?page=2')
    expect(router.stores.resolvedLocation.get()?.searchStr).toBe('?page=1')
    expect(
      (router.stores.matches.get().at(-1)?.search as { page?: number }).page,
    ).toBe(2)

    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(seeded).toBe('?page=1|page=1')

    gate.resolve()
    await act(async () => {
      await gate.promise
    })
  })

  /**
   * A published pending lane does not reach the seed.
   *
   * Once a route with a `pendingComponent` publishes its pending lane,
   * `stores.matches` holds the *destination's* matches while
   * `resolvedLocation` still names the route on screen. The seed takes
   * neither the head nor a mixture of the two: it takes the last committed
   * publication, `router._committed` paired with `resolvedLocation`, which is
   * what a tree that had stayed mounted through this navigation is
   * presenting — its committed frame does not advance while `status` is
   * pending.
   *
   * Asserted on the owner's seeded frame rather than on screen: at that moment
   * the pending fallback covers the tree, so a rendered probe cannot tell the
   * candidates apart even though the frame differs.
   */
  test('an owner seeded after pending matches publish takes the committed publication', async () => {
    const gate = deferred()
    let seeded: string | undefined

    function CaptureOwner({ children }: { children?: React.ReactNode }) {
      const owner = useRouterStateOwner()
      if (owner && seeded === undefined) {
        seeded = `${owner.frame.location.pathname}|${owner.frame.matches
          .map((m) => m.routeId)
          .join('+')}`
      }
      return <>{children}</>
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
      pendingComponent: () => <h1>Slow Pending</h1>,
      component: () => <h1>Slow Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, slowRoute]),
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      experimental_concurrentRenderFrames: false,
    })

    const first = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    first.unmount()

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
        InnerWrap: CaptureOwner,
      })
    })

    const navigation = router.navigate({ to: '/slow' })
    navigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The state that makes this reachable: destination matches in the store,
    // the previous publication still committed.
    expect(router.stores.matches.get().map((m) => m.routeId)).toEqual([
      '__root__',
      '/slow',
    ])
    expect(router._committed.map((m) => m.routeId)).toEqual(['__root__', '/'])
    expect(router.stores.resolvedLocation.get()?.pathname).toBe('/')

    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The publication still on screen, not the destination's matches and not
    // a mixture of the two.
    expect(seeded).toBe('/|__root__+/')

    gate.resolve()
    await act(async () => {
      await gate.promise
    })
  })

  /**
   * The seed compares the history entry, not just the href.
   *
   * A same-URL navigation that pushes a new history entry leaves
   * `resolvedLocation.href` equal to the head's, while their `__TSR_key`
   * values differ. Comparing hrefs alone therefore reads the head as coherent
   * and seeds from it, pairing the *uncommitted* destination state with the
   * previously resolved matches — a freshly mounted tree would show history
   * state that nothing has committed.
   *
   * Both guards that ask "has the location moved?" now go through one
   * `sameLocation`, so the seed cannot drift into comparing less than the
   * supersession check does. Unlike the same-URL half of the supersession
   * test, this one is reachable: with an href-only comparison the mounted
   * tree reads the destination's state, and with the key compared it reads
   * the publication that is actually committed.
   */
  test('an owner seeded during a same-url navigation compares the history entry', async () => {
    const gate = deferred()
    let loads = 0

    // The seed is read at owner creation rather than from the rendered tree:
    // mounting a frame-path provider into a store-path navigation settles
    // that navigation's outstanding acknowledgement, so the frame advances
    // to the destination shortly afterwards and a rendered probe would be
    // asserting the publication that follows the seed rather than the seed.
    let seeded: string | undefined
    function CaptureOwner({ children }: { children?: React.ReactNode }) {
      const owner = useRouterStateOwner()
      if (owner && seeded === undefined) {
        const state = owner.frame.location.state as {
          n?: number
          __TSR_key?: string
        }
        seeded = `${state.n ?? 'none'}|${state.__TSR_key ?? 'none'}`
      }
      return <>{children}</>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      loader: () => {
        loads += 1
        return loads === 1 ? 'first' : gate.promise
      },
      component: () => <h1>Index Title</h1>,
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      defaultPendingMs: 0,
      // The store path commits without building an owner, so the mount below
      // is what builds one.
      experimental_concurrentRenderFrames: false,
    })

    const first = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    const committedKey = router.stores.location.get().state.__TSR_key
    first.unmount()

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
        InnerWrap: CaptureOwner,
      })
    })

    // Same URL, new history entry: the hrefs match, the keys do not.
    const navigation = router.navigate({
      to: '/',
      // `n` rides along so the uncommitted state is visible if it leaks.
      state: ((previous: Record<string, unknown>) => ({
        ...previous,
        n: 2,
      })) as unknown as Parameters<typeof router.navigate>[0]['state'],
    })
    navigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const head = router.stores.location.get()
    const resolved = router.stores.resolvedLocation.get()
    expect(resolved?.href).toBe(head.href)
    expect(resolved?.state.__TSR_key).not.toBe(head.state.__TSR_key)

    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The committed entry, not the one the navigation is heading for.
    expect(seeded).toBe(`none|${committedKey}`)

    gate.resolve()
    await act(async () => {
      await gate.promise
    })
  })

  /**
   * An owner seeded inside the publication window takes the acknowledged pair.
   *
   * Matches are published inside the framework's transition callback —
   * `router._committed` is the destination's from that moment — while
   * `resolvedLocation` only advances once the framework acknowledges the
   * publication. A provider that unmounts between the two (here from
   * `onLoad`, which core emits inside that same callback) leaves the next
   * mount to seed from a router whose two halves describe different
   * navigations. Pairing them would mount the destination's route effects
   * under the URL being left.
   *
   * `router._resolvedMatches` is the other half of `resolvedLocation`: the
   * matches the framework has acknowledged. A mounted frame-path tree does
   * not advance in this window either — its committed frame moves at the
   * acknowledgement — so the seeded tree and the mounted one agree.
   */
  test('an owner seeded inside the publication window takes the acknowledged matches', async () => {
    const hold = deferred()
    let released = false
    hold.promise.then(() => {
      released = true
    })
    let seeded: string | undefined

    function CaptureOwner({ children }: { children?: React.ReactNode }) {
      const owner = useRouterStateOwner()
      if (owner && seeded === undefined) {
        seeded = `${owner.frame.location.pathname}|${owner.frame.matches
          .map((match) => match.routeId)
          .join('+')}`
      }
      return <>{children}</>
    }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <h1>Index Title</h1>,
    })
    const otherRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/other',
      component: function OtherComponent() {
        // Keeps the store-path tree from acknowledging on its own, so the
        // window is closed by the unmount below rather than by a race.
        if (!released) {
          throw hold.promise
        }
        return <h1>Other Title</h1>
      },
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
      defaultPendingMs: 0,
      // The store path commits matches without building an owner, which is
      // what leaves the mount below to build a fresh one.
      experimental_concurrentRenderFrames: false,
    })

    const unmountStored: { current?: () => void } = {}
    router.subscribe('onLoad', () => {
      unmountStored.current?.()
    })

    const stored = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    unmountStored.current = () => stored.unmount()

    const navigation = router.navigate({ to: '/other' })
    navigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Mid-publication: the matches have moved, the acknowledgement has not.
    expect(router.stores.location.get().pathname).toBe('/other')
    expect(router.stores.resolvedLocation.get()?.pathname).toBe('/')
    expect(router._committed.map((match) => match.routeId)).toEqual([
      '__root__',
      '/other',
    ])

    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
        InnerWrap: CaptureOwner,
      })
    })
    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The acknowledged publication, not a half of each.
    expect(seeded).toBe('/|__root__+/')

    hold.resolve()
    await act(async () => {
      await hold.promise
    })
  })

  /**
   * An acknowledgement outstanding across a change of path is settled, not
   * stranded.
   *
   * `router._rendered` carries the representation of the tree it was offered
   * to: a frame identity on the frame path, the published matches on the
   * store path. A provider replaced while
   * `experimental_concurrentRenderFrames` changes leaves the successor
   * holding an offer it cannot satisfy in either direction — and because the
   * load is already in flight, nothing starts another one, so the navigation
   * promise never settles and `status` stays pending for the router's
   * lifetime.
   *
   * The successor did not render that publication, so the honest
   * acknowledgement is the one a navigation gets when nothing is mounted to
   * acknowledge it: unrendered. The load then resolves and the new tree
   * presents the publication from the store like any other reader.
   *
   * Both directions, and a same-mode replacement as the control: that one
   * recovers on its own, because the successor can satisfy the offer.
   */
  test('an acknowledgement outstanding across a path change settles', async () => {
    const observed: Array<string> = []

    for (const [from, flip] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ] as Array<[boolean, boolean]>) {
      const hold = deferred()
      let released = false

      const rootRoute = createRootRoute({ component: () => <Outlet /> })
      const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <h1>Index Title</h1>,
      })
      const otherRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/other',
        component: function OtherComponent() {
          if (!released) {
            throw hold.promise
          }
          return <h1>Other Title</h1>
        },
      })
      const router = createRouter({
        routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
        defaultPendingMs: 0,
        experimental_concurrentRenderFrames: from,
      })

      // Unmount from `onLoad`, which core emits inside the transition
      // callback: the offer is outstanding and nothing has acknowledged it.
      const unmountStored: { current?: () => void } = {}
      router.subscribe('onLoad', () => {
        unmountStored.current?.()
      })

      const stored = render(<RouterProvider router={router} />)
      await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
      unmountStored.current = () => stored.unmount()

      let settled = false
      const navigation = router.navigate({ to: '/other' })
      navigation.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      act(() => {
        router.update({
          ...router.options,
          experimental_concurrentRenderFrames: flip ? !from : from,
        })
      })
      render(<RouterProvider router={router} />)
      released = true
      hold.resolve()
      await act(async () => {
        await hold.promise
        await Promise.resolve()
      })
      await waitFor(() => expect(router.stores.status.get()).toBe('idle'))

      observed.push(`from=${from} flip=${flip} settled=${settled}`)
      cleanup()
      window.history.replaceState(null, 'root', '/')
    }

    expect(observed).toEqual([
      'from=false flip=true settled=true',
      'from=true flip=true settled=true',
      'from=false flip=false settled=true',
      'from=true flip=false settled=true',
    ])
  })

  /**
   * A superseded pending frame does not block a resync.
   *
   * An owner outlives its trees, and a frame staged but never acknowledged —
   * its tree suspended, then unmounted — stays in `pending`. Nothing can
   * commit it afterwards: `owner.pending` refuses to hand it out and `commit`
   * cancels it. What it could still do is block `resync`, so a later
   * frame-path mount rendered the route from *before* that frame while the
   * router had since navigated somewhere else entirely on the store path —
   * and ran its effects, which is how a `<Navigate>` there would fire.
   *
   * Asserted on mount effects rather than on screen, for the usual reason:
   * the correction lands before paint, so the screen looks right while the
   * stale route has already mounted.
   */
  test('a superseded pending frame does not block a resync', async () => {
    const gate = deferred()
    const suspend = deferred()
    const mounted: Array<string> = []
    let seeded: string | undefined

    function CaptureOwner({ children }: { children?: React.ReactNode }) {
      const owner = useRouterStateOwner()
      if (owner && seeded === undefined) {
        seeded = `${owner.frame.location.pathname}|${owner.frame.matches
          .map((match) => match.routeId)
          .join('+')}`
      }
      return <>{children}</>
    }

    const track = (name: string) =>
      function Tracked() {
        React.useEffect(() => {
          mounted.push(name)
        }, [])
        return <h1>{name}</h1>
      }

    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: track('index'),
    })
    const stagedRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/staged',
      loader: () => gate.promise,
      // Suspends for the rest of the test, so its frame is staged and never
      // acknowledged, and the owner still holds it after the unmount.
      component: function StagedRoute(): React.ReactNode {
        throw suspend.promise
      },
    })
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      component: track('next'),
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, stagedRoute, nextRoute]),
      defaultPendingMs: 0,
      experimental_concurrentRenderFrames: true,
    })

    const first = render(<RouterProvider router={router} />)
    await waitFor(() => screen.getByRole('heading', { name: 'index' }))
    const staging = router.navigate({ to: '/staged' })
    staging.catch(() => {})
    await waitFor(() => expect(router.stores.status.get()).toBe('pending'))
    gate.resolve()
    await act(async () => {
      await gate.promise
    })
    first.unmount()

    // The store path navigates on, with nothing driving the owner.
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: false,
      })
    })
    const stored = render(<RouterProvider router={router} />)
    await act(async () => {
      await router.navigate({ to: '/next' })
    })
    await waitFor(() => screen.getByRole('heading', { name: 'next' }))
    stored.unmount()

    // Back on the frame path, onto the cached owner.
    mounted.length = 0
    act(() => {
      router.update({
        ...router.options,
        experimental_concurrentRenderFrames: true,
        InnerWrap: CaptureOwner,
      })
    })
    render(<RouterProvider router={router} />)
    await act(async () => {
      await Promise.resolve()
    })

    // The route the router is on, and only that one.
    expect(seeded).toBe('/next|__root__+/next')
    expect(mounted).toEqual(['next'])
  })

  /**
   * A provider handed a router that holds a foreign offer settles it.
   *
   * The mismatch between an acknowledgement's representation and the tree
   * that has to satisfy it does not need a mount: a mounted provider handed a
   * *different* router inherits that router's outstanding offer, which may
   * have been made to a tree on the other path. The load is already in
   * flight, so nothing starts another one, and the navigation promise never
   * settles.
   *
   * The acknowledgement slot is per router, so the normalization runs when
   * the router changes rather than only when the provider mounts. Reads
   * `settled=false` / `pending` with a mount-only effect.
   */
  test('a provider handed a router holding a foreign offer settles it', async () => {
    const suspend = deferred()
    let released = false

    const build = (frames: boolean) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> })
      const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <h1>Index Title</h1>,
      })
      const otherRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/other',
        component: function OtherComponent() {
          if (!released) {
            throw suspend.promise
          }
          return <h1>Other Title</h1>
        },
      })
      return createRouter({
        routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
        defaultPendingMs: 0,
        experimental_concurrentRenderFrames: frames,
      })
    }

    const mountedRouter = build(true)
    const swapped = build(false)

    // The swapped-to router runs a store-path navigation whose tree unmounts
    // from `onLoad`, leaving its offer outstanding as published matches.
    const unmountStored: { current?: () => void } = {}
    swapped.subscribe('onLoad', () => {
      unmountStored.current?.()
    })
    const stored = render(<RouterProvider router={swapped} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    unmountStored.current = () => stored.unmount()

    let settled = false
    const navigation = swapped.navigate({ to: '/other' })
    navigation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // It is now configured for frames, and a mounted frame-path provider is
    // handed it without unmounting.
    swapped.update({
      ...swapped.options,
      experimental_concurrentRenderFrames: true,
    })
    const provider = render(<RouterProvider router={mountedRouter} />)
    await act(async () => {
      await Promise.resolve()
    })
    provider.rerender(<RouterProvider router={swapped} />)

    released = true
    suspend.resolve()
    await act(async () => {
      await suspend.promise
      await Promise.resolve()
    })
    await waitFor(() => expect(swapped.stores.status.get()).toBe('idle'))
    expect(settled).toBe(true)
  })

  /**
   * A store-path provider nested under a frame-path one owns no frames.
   *
   * `Transitioner` takes its owner from context without consulting the mode,
   * and the store-path arm of `RouterContextProvider` used to publish only the
   * mode — so a nested store-path provider inherited the *outer* router's
   * owner and drove it with its own publications. That writes a `frameId` into
   * the inner router's acknowledgement slot, where its own `Matches` is
   * looking for a set of matches, so the inner navigation is never
   * acknowledged: it stays `pending` for good, its route never renders and its
   * promise never settles.
   *
   * The control that makes this a regression rather than a limitation of
   * nesting: with the outer provider on the store path the same tree works
   * perfectly, so the outer router's option is what breaks the inner one.
   */
  test('a nested store-path provider is not driven by the outer frame owner', async () => {
    const innerRoot = createRootRoute({ component: () => <Outlet /> })
    const innerIndex = createRoute({
      getParentRoute: () => innerRoot,
      path: '/',
      component: () => <h1>Inner Index</h1>,
    })
    const innerOther = createRoute({
      getParentRoute: () => innerRoot,
      path: '/other',
      component: () => <h1>Inner Other</h1>,
    })
    const inner = createRouter({
      routeTree: innerRoot.addChildren([innerIndex, innerOther]),
      experimental_concurrentRenderFrames: false,
      // Its own history, so navigating it cannot move the outer router.
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })

    const outerRoot = createRootRoute({ component: () => <Outlet /> })
    const outerIndex = createRoute({
      getParentRoute: () => outerRoot,
      path: '/',
      component: () => (
        <>
          <h1>Outer Index</h1>
          <RouterProvider router={inner} />
        </>
      ),
    })
    const outerPosts = createRoute({
      getParentRoute: () => outerRoot,
      path: '/posts',
      component: () => <h1>Outer Posts</h1>,
    })
    const outer = createRouter({
      routeTree: outerRoot.addChildren([outerIndex, outerPosts]),
      experimental_concurrentRenderFrames: true,
    })

    render(<RouterProvider router={outer} />)
    await waitFor(() => screen.getByRole('heading', { name: 'Outer Index' }))
    await waitFor(() => screen.getByRole('heading', { name: 'Inner Index' }))
    expect(inner.stores.status.get()).toBe('idle')

    let innerNavigation!: Promise<void>
    act(() => {
      innerNavigation = inner.navigate({ to: '/other' })
    })
    innerNavigation.catch(() => {})
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => screen.getByRole('heading', { name: 'Inner Other' }))
    expect(inner.stores.status.get()).toBe('idle')
    // The inner router acknowledges with matches, never a frame identity.
    expect(typeof inner._rendered?.[0]).not.toBe('number')
    await innerNavigation

    // And the outer router is still able to navigate afterwards.
    let outerNavigation!: Promise<void>
    act(() => {
      outerNavigation = outer.navigate({ to: '/posts' })
    })
    outerNavigation.catch(() => {})
    await waitFor(() => screen.getByRole('heading', { name: 'Outer Posts' }))
    await outerNavigation
  })
})
