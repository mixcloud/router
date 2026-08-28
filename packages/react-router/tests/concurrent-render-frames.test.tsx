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
  Outlet,
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
