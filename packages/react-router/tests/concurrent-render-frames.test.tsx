import { afterEach, describe, expect, test } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '../src'

afterEach(() => {
  window.history.replaceState(null, 'root', '/')
  cleanup()
})

/**
 * Two consumers of `useRouterState` with different selections: one that changes
 * on every navigation, and one that does not. A fine-grained selector contract
 * means only the first re-renders.
 */
function setup(experimental_concurrentRenderFrames: boolean) {
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
    component: function RootComponent() {
      return (
        <>
          <Link to="/">Back</Link>
          <Link to="/posts">Posts</Link>
          <ChangingConsumer />
          <StableConsumer />
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

  const postsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/posts',
    component: () => <h1>Posts Title</h1>,
  })

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, postsRoute]),
    experimental_concurrentRenderFrames,
  })

  render(<RouterProvider router={router} />)

  return { renders, router }
}

async function navigateToPosts() {
  const link = await waitFor(() => screen.getByRole('link', { name: 'Posts' }))
  fireEvent.click(link)
  await waitFor(() => screen.getByRole('heading', { name: 'Posts Title' }))
}

describe.each([
  ['store subscriptions', false],
  ['concurrent render frames', true],
])('%s', (_name, frames) => {
  test('a consumer re-renders only when its own selection changes', async () => {
    const { renders } = setup(frames)

    await waitFor(() => screen.getByRole('heading', { name: 'Index Title' }))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')

    const before = { ...renders }
    await navigateToPosts()

    // The selection changed, so this consumer must have re-rendered.
    expect(renders.changing).toBeGreaterThan(before.changing)
    expect(screen.getByTestId('pathname')).toHaveTextContent('/posts')

    // The selection did not change, so this consumer must not have.
    expect(renders.stable).toBe(before.stable)
  })
})
